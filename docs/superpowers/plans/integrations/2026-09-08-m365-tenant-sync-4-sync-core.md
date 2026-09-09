# M365 tenant sync foundation — Wave 04: sync core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task is red-first: write the failing test with REAL code, run it, watch it fail, then implement.

**Goal:** stand up the API-side sync engine — the DB-free executor call helper, the sync budget family, the claim/lease/generation ticker, and the three-phase `sync-domain` job persisting `users` (primary fields only), `intune_devices`, `ca_policies` and `skus` with change-only writes — all behind `M365_TENANT_SYNC_ENABLED`, with the `m365_sync_*` metric surface and one audit event per run.

**Architecture:** `m365_sync_state` *is* the schedule; there is no cron. A 60 s BullMQ repeat job (`tick`) reads queue depth from Redis, then in one short system transaction reconciles missing state rows, publishes the due-backlog gauge, and claims up to `M365_SYNC_TICK_BATCH` rows with `FOR UPDATE OF s SKIP LOCKED`, bumping `run_generation` and taking a 20-minute lease **without touching `next_sync_at`**; after the commit it enqueues one `sync-domain` job per claimed row. Each job runs three phases: **A** snapshot + fencing under a short system transaction, **B** the Graph fetch with **no DB context held**, **C** fenced persist in chunked short transactions. Only a *complete* run (primary source `ok`, `truncated=false`) marks stale rows. Cadence adaptation and the rollup are W05: this wave leaves two clearly named, tested seams (`applyCadence`, `afterDomainPersisted`) that W05 fills.

**Tech stack:** TypeScript, Drizzle ORM + hand-written SQL fragments (`sql` template + `PgDialect` compiled-SQL assertions), BullMQ + Redis, `prom-client`, Zod (`@breeze/shared/m365`), Vitest (unit + real-Postgres integration).

**Spec:** `docs/superpowers/specs/integrations/2026-09-08-m365-tenant-sync-foundation-design.md` — this wave implements §5.1–5.4, §5.9 (counts only), §5.10, §6, §7, §10 steps 1–2. Sections are cited per task.

**Overview / shared interface contract:** `docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-0-overview.md` (tracking issue `LanternOps/breeze#5327`). Module names, function signatures, job/queue names, env names and metric names in that file are **fixed**. **Contract edits are the orchestrator's — this wave does NOT edit the overview file.** Every deviation this plan takes is listed under "Contract deltas" below and is restated in the PR body; the orchestrator folds them into the overview.

## Global constraints (inherited from the overview; every task obeys them)

- All new tables are shape 1 (`org_id NOT NULL` → `organizations(id)`); **W02 owns the migration** — this wave adds no migration and must not edit one.
- Composite FKs on `(x, org_id)` are `DEFERRABLE INITIALLY IMMEDIATE`.
- **BullMQ custom job ids contain no `:`.** `syncJobId()` is the only place a job id is built; a test pins the absence.
- **Fail-closed:** no Redis budget signal = deny; missing flag = off.
- Never call the bare pool in request code. **Contextless DB access is a denial, not a bypass** — every read and write in this wave runs inside `withSystemDbAccessContext` (this is a cross-org scheduler, spec §8), and the Graph fetch runs inside `runOutsideDbContext` so no pooled connection is pinned idle-in-transaction across the network call (#1105/#1697).
- Test one file with `cd apps/api && npx vitest run <path>` — **never** `pnpm … test -- --run <path>` (the `--` is forwarded into argv, `--run` is swallowed as a positional, and the FULL suite runs in watch mode).
- Vitest's path filter is a plain substring match, not a glob: `npx vitest run src/services/m365Sync` matches the directory and its subdirectories, but a trailing slash would silently skip sibling files. Always check the reported file count.
- Executor projection allowlists are the only fields that leave the executor; nothing here re-derives Graph fields.
- **Never bind a `Date` into a raw `sql\`\`` fragment.** postgres.js throws `Buffer.byteLength` at bind time and compiled-SQL tests do not catch it — bind `date.toISOString()` and cast with `::timestamptz`.

## Consumed from W02 and W03 (treat as existing; verify before starting)

Run this before Task 1. If any check fails, W02/W03 have not landed on this branch's base — stop.

```bash
test -f apps/api/src/db/schema/m365Sync.ts \
  && grep -q 'm365SyncState' apps/api/src/db/schema/m365Sync.ts \
  && grep -q 'm365Users' apps/api/src/db/schema/m365Sync.ts \
  && grep -q 'M365_SYNC_DOMAINS' packages/shared/src/m365/sync.ts \
  && grep -q 'syncAction' apps/api/src/services/m365ControlPlane/graphReadExecutorClient.ts \
  && echo OK-W02-W03
```

**From W02** (`apps/api/src/db/schema/m365Sync.ts`, re-exported from `apps/api/src/db/schema/index.ts`): `m365SyncState`, `m365Users`, `m365IntuneDevices`, `m365CaPolicies`, `m365LicenseSkus`, `m365SecureScoreSnapshots`, `m365PostureRollups`; enums `m365_sync_domain`, `m365_sync_status`; unique `(org_id, domain)` on `m365_sync_state`, unique `(org_id, graph_id)` on every entity table, partial index on `next_sync_at WHERE next_sync_at IS NOT NULL`, and `m365_connections (id, org_id)` unique.

**From W03**: `@breeze/shared/m365` exports `M365_SYNC_DOMAINS`, `M365SyncDomain`, `M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS`, `M365_SYNC_DOMAIN_INTERVAL_BOUNDS`, `M365_SYNC_ACTION_IDS`, `M365SyncActionId`, `isM365SyncActionId`, `M365SyncSourceState`, `M365SyncActionResult`, `m365SyncActionResultSchema`, **`M365SyncFailureCode`**, **`m365SyncFailureCodeSchema`**, **`m365SyncActionResponseSchema`**, and the six sync branches inside `m365ReadActionSchema` / `M365ReadAction`. `GraphReadExecutorClient` gains `syncAction(input: { correlationId; tenantId; action })` returning `Promise<M365SyncActionResult | GraphReadExecutorFailure>` where

```ts
// W03 owns this type. The discriminant field is `code`, NOT `errorCode` —
// `errorCode` is the shape of the three shipped INTERACTIVE operations, and
// /v1/sync-action deliberately uses `code` so it matches the 400/503 bodies
// the executor already emits (`{ error, code }`). Nothing in this wave may
// read `.errorCode` off a sync response.
export interface GraphReadExecutorFailure {
  success: false;
  code: M365SyncFailureCode | 'sync_capacity';
  retryAfterSeconds?: number;
}
// M365SyncFailureCode = ReadActionFailureCode | 'continuation_invalid' | 'graph_throttled'
```

## Contract deltas this wave takes (restate in the PR body; the ORCHESTRATOR folds them into the overview)

1. **`callGraphReadExecutor`'s audit stays on the read route only.** The contract says the helper does "budget check, client call, metrics, audit event". Verified against `apps/api/src/services/auditService.ts:54-79`: `recordM365ReadActionEvent` → `writeAuditEvent` → `void writeAuditEventAsync` → `createAuditLogAsync` → `persistAuditLog`, which is fire-and-forget and opens its **own** `runOutsideDbContext(() => withSystemDbAccessContext(...))`. So the helper never opens, inherits, or holds a DB context — the "DB-free" property in spec §5.1 holds with the audit call left in place, and the read path stays byte-identical. But spec §7 requires **exactly one** audit event per `sync-domain` run carrying counts and outcome, neither of which exists at executor-call time. Therefore: route `'read'` records `recordM365ReadActionEvent` exactly as today; route `'sync'` records only the `m365_sync_executor_seconds` histogram, and `run.ts` writes the single `m365.sync.run` event after Phase C. `opts` gains an optional `recordEvent` injection point so a future caller can override without forking the helper.
2. **`opts` gains `auditRequest?: RequestLike` and `recordEvent?`** (both optional, additive) so `executeM365ReadAction` can forward its existing `auditRequest` parameter unchanged.
3. **`M365ConnectionExecutionSnapshot.vaultRef` / `.credentialVersion` stay `string`** per the contract even though the columns are nullable: both loaders coerce with `?? ''`. The helper never reads them (the executor owns the credential — `executeReadAction`/`syncAction` send only `{correlationId, tenantId, action}`); they exist for caller-side fencing and diagnostics.
4. **`runSyncDomain(data, opts?)`** takes an optional second argument `{ isFinalAttempt?, now?, rng?, callExecutor? }` — needed for BullMQ's final-attempt semantics and for test injection. Additive; the one-argument call in the contract still type-checks.
5. **`claimDueDomains(opts)`** gains optional `orgId`, `domains`, `priority` so `claimAndEnqueue` reuses the same statement (spec §5.2: "On-demand sync and post-consent seeding use the same claim function"). Additive.
6. **New leaf module `apps/api/src/jobs/m365SyncQueue.ts`** holds the `Queue` accessor and the enqueue helper. `services/m365Sync/claim.ts` needs to enqueue and `jobs/m365SyncWorker.ts` needs to claim; without the leaf they import each other. The contract names only `jobs/m365SyncWorker.ts`; this is additive and prevents an import cycle.
7. **`applyCadence` lives in `services/m365Sync/cadence.ts`; `afterDomainPersisted` lives in `services/m365Sync/hooks.ts`.** Both are W04 seams with headers naming W05 as their owner; W05 edits these files rather than creating them. `applyCadence` takes an **optional fifth argument `rng?: () => number`** (default `Math.random`) so the ±10 % jitter is injectable from a test; the contract's four-argument call still type-checks. `cadence.ts` also owns and exports `nextSyncAt(now, intervalSeconds, rng?)` — `run.ts` never computes a due time itself, it stores the `{ intervalSeconds, nextSyncAt }` pair `applyCadence` returns.
8. **`reconcileEligibleConnections()` seeds only `M365_SYNC_IMPLEMENTED_DOMAINS` (the four this wave persists).** Seeding all six now would make `signin_activity` and `secure_score` claimable with no persister, so they would be re-claimed every tick forever and burn ticker slots. W05 widens the constant to all six when it lands their persisters.
9. **Metric names carry no `breeze_` prefix** (`m365_sync_runs_total`, not `breeze_m365_sync_runs_total`), departing from the neighbouring `breeze_m365_graph_read_actions_total`. The contract and spec §7 both pin the unprefixed names; they win.
10. **Auth failure does not throw.** The prompt/spec reach for `UnrecoverableError`, but `attachWorkerObservability`'s `failed` handler captures **every** failure to Sentry unconditionally (`apps/api/src/jobs/workerObservability.ts:231-241`) and the required-attach contract test forbids skipping it. So a connection auth failure is recorded terminally inside `runSyncDomain` (`last_status='error'`, `next_sync_at=NULL`, lease cleared) and **returned**, never thrown — which is what spec §6 actually asks for ("Run stops; not sent to Sentry"). `UnrecoverableError` is still used, for a malformed `sync-domain` payload, where retrying three times is pure waste and a Sentry report is wanted.

## Task ordering

Strictly sequential. One PR, one commit per task.

| # | Task | Depends on |
|---|---|---|
| 1 | Flag, env knobs, boot validation, compose/env-example threading | — |
| 2 | `consumeM365SyncBudget` | — |
| 3 | `callGraphReadExecutor` refactor | 2 |
| 4 | `types.ts` + `hash.ts` | — |
| 5 | `metrics.ts` + `/metrics` registration | 4 |
| 6 | `claim.ts`: `syncJobId`, `reconcileEligibleConnections` | 4 |
| 7 | `jobs/m365SyncQueue.ts` + `claimDueDomains` / `claimAndEnqueue` | 6 |
| 8 | `domains/users.ts` | 4 |
| 9 | `domains/intuneDevices.ts` | 4 |
| 10 | `domains/caPolicies.ts` | 4 |
| 11 | `domains/skus.ts` | 4 |
| 12 | `run.ts` Phase A: `loadSyncRunContext` + fencing | 3, 4 |
| 13 | `run.ts` Phases B/C: `runSyncDomain`, seams, audit | 5, 8–12 |
| 14 | `jobs/m365SyncWorker.ts`: tick, processor, backoff, error classes | 7, 13 |
| 15 | Worker registry + readiness manifest wiring | 14 |
| 16 | Claim protocol integration test (real Postgres) | 7 |
| 17 | Full verification, typecheck, PR | all |

---

### Task 1: Feature flag, sync env knobs, boot validation, compose threading

Spec §10 step 1 ("**Every** sync entry point is gated by `M365_TENANT_SYNC_ENABLED`, default `false`, boot-validated") and §5.3/§5.2 for the three numeric knobs.

**Files:**
- Edit: `apps/api/src/config/env.ts`
- Edit: `apps/api/src/config/validate.ts`
- Create: `apps/api/src/config/env.m365Sync.test.ts`
- Edit: `apps/api/src/config/validate.test.ts`
- Edit: `.env.example`, `docker-compose.yml`, `deploy/.env.example`, `deploy/docker-compose.prod.yml`

**Interfaces:**
- Consumes: nothing from W02/W03.
- Produces (used by Tasks 7, 13, 14 and by W05's lifecycle hooks and on-demand route):
  - `export function isM365TenantSyncEnabled(): boolean` — `envFlag('M365_TENANT_SYNC_ENABLED', false)`, read at CALL time.
  - `export function m365SyncConcurrency(): number` — `M365_SYNC_CONCURRENCY`, default 4, clamped `[1, 64]`.
  - `export function m365SyncMaxBacklog(): number` — `M365_SYNC_MAX_BACKLOG`, default 500, clamped `[1, 100_000]`.
  - `export function m365SyncTickBatch(): number` — `M365_SYNC_TICK_BATCH`, default 200, clamped `[1, 5_000]`.

> ⚠️ `apps/api/src/config/envComposeParity.test.ts` (required **Test API** job) fails when a variable documented in an `.env.example` is not referenced by its paired compose file. There are **two** pairs: `.env.example` ↔ `docker-compose.yml` and `deploy/.env.example` ↔ `deploy/docker-compose.prod.yml`. All four files change in this task or CI reds.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/config/env.m365Sync.test.ts` (new):

```ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  isM365TenantSyncEnabled,
  m365SyncConcurrency,
  m365SyncMaxBacklog,
  m365SyncTickBatch,
} from './env';

const KEYS = [
  'M365_TENANT_SYNC_ENABLED',
  'M365_SYNC_CONCURRENCY',
  'M365_SYNC_MAX_BACKLOG',
  'M365_SYNC_TICK_BATCH',
] as const;

describe('M365 tenant sync env (spec §10 step 1)', () => {
  const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of KEYS) {
      const v = original[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it.each([
    [undefined, false], ['', false], ['false', false], ['0', false], ['no', false],
    ['off', false], ['garbage', false],
    ['true', true], ['1', true], ['yes', true], ['on', true], ['TRUE', true], ['  true  ', true],
  ])('M365_TENANT_SYNC_ENABLED=%s → %s', (raw, expected) => {
    if (raw === undefined) delete process.env.M365_TENANT_SYNC_ENABLED;
    else process.env.M365_TENANT_SYNC_ENABLED = raw as string;
    expect(isM365TenantSyncEnabled()).toBe(expected);
  });

  it('is read at call time, so flipping the flag off actually turns the ticker off', () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    expect(isM365TenantSyncEnabled()).toBe(true);
    process.env.M365_TENANT_SYNC_ENABLED = 'false';
    expect(isM365TenantSyncEnabled()).toBe(false);
  });

  it('defaults the three knobs to 4 / 500 / 200 when unset', () => {
    delete process.env.M365_SYNC_CONCURRENCY;
    delete process.env.M365_SYNC_MAX_BACKLOG;
    delete process.env.M365_SYNC_TICK_BATCH;
    expect(m365SyncConcurrency()).toBe(4);
    expect(m365SyncMaxBacklog()).toBe(500);
    expect(m365SyncTickBatch()).toBe(200);
  });

  it.each([
    ['', 4], ['abc', 4], ['0', 4], ['-3', 4], ['4.9', 4], ['9999', 64],
    ['1', 1], ['16', 16],
  ])('M365_SYNC_CONCURRENCY=%s → %s (garbage and out-of-range fall back or clamp)', (raw, expected) => {
    process.env.M365_SYNC_CONCURRENCY = raw as string;
    expect(m365SyncConcurrency()).toBe(expected);
  });

  it('clamps the tick batch and backlog rather than trusting an operator typo', () => {
    process.env.M365_SYNC_TICK_BATCH = '999999';
    expect(m365SyncTickBatch()).toBe(5_000);
    process.env.M365_SYNC_MAX_BACKLOG = '0';
    expect(m365SyncMaxBacklog()).toBe(500);
  });
});
```

Append to `apps/api/src/config/validate.test.ts` (inside the existing top-level `describe`, next to the `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` block):

```ts
describe('M365_TENANT_SYNC_ENABLED + sync knobs (wave 04)', () => {
  it('declares every sync key in the schema so buildEnvParseInput sees it', () => {
    expect(ENV_SCHEMA_KEYS).toContain('M365_TENANT_SYNC_ENABLED');
    expect(ENV_SCHEMA_KEYS).toContain('M365_SYNC_CONCURRENCY');
    expect(ENV_SCHEMA_KEYS).toContain('M365_SYNC_MAX_BACKLOG');
    expect(ENV_SCHEMA_KEYS).toContain('M365_SYNC_TICK_BATCH');
  });

  it('refuses boot on a non-boolean M365_TENANT_SYNC_ENABLED (a typo must not read as OFF)', () => {
    const result = validateConfig({ ...baseEnv(), M365_TENANT_SYNC_ENABLED: 'tru' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('M365_TENANT_SYNC_ENABLED must be a boolean');
  });

  it('accepts every recognised boolean spelling', () => {
    for (const raw of ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off']) {
      expect(validateConfig({ ...baseEnv(), M365_TENANT_SYNC_ENABLED: raw }).success).toBe(true);
    }
  });

  it('refuses boot on a non-integer sync knob', () => {
    const result = validateConfig({ ...baseEnv(), M365_SYNC_TICK_BATCH: 'lots' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('M365_SYNC_TICK_BATCH');
  });
});
```

> Reuse whatever this file already calls to build a minimal valid environment — read the top of `validate.test.ts` and use the existing helper rather than introducing `baseEnv()` if one is already there under another name.

- [ ] **Step 2: Run the tests — they must FAIL** (`isM365TenantSyncEnabled is not a function`, and the schema-key assertions must be red):

```bash
cd apps/api && npx vitest run src/config/env.m365Sync.test.ts src/config/validate.test.ts
```

- [ ] **Step 3: Implement**

In `apps/api/src/config/env.ts`, immediately after `m365CustomerGraphActionsOnboardingEnabled()`:

```ts
// Microsoft 365 tenant sync (spec §10). Dark by default and boot-validated.
// Read at CALL time, never as a module-scope const: the ticker registration in
// jobs/m365SyncWorker.ts removes its repeat entry when this is off, so an
// operator flipping the flag and restarting must actually stop the scheduler.
export function isM365TenantSyncEnabled(): boolean {
  return envFlag('M365_TENANT_SYNC_ENABLED', false);
}

/**
 * Positive-integer env knob with a hard clamp. A knob is a capacity dial an
 * operator turns under load; an unparseable or out-of-range value must land on
 * a safe number rather than NaN (which would make `depth > NaN` false and
 * disable backpressure entirely).
 */
function positiveIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** Per-API-instance `sync-domain` concurrency (spec §5.3). */
export function m365SyncConcurrency(): number {
  return positiveIntEnv('M365_SYNC_CONCURRENCY', 4, 1, 64);
}

/** Ticker backpressure ceiling on waiting+prioritized+delayed+active (spec §5.2 step 1). */
export function m365SyncMaxBacklog(): number {
  return positiveIntEnv('M365_SYNC_MAX_BACKLOG', 500, 1, 100_000);
}

/** Rows claimed per tick (spec §5.2 step 3, §5.9 — this is the capacity dial). */
export function m365SyncTickBatch(): number {
  return positiveIntEnv('M365_SYNC_TICK_BATCH', 200, 1, 5_000);
}
```

In `apps/api/src/config/validate.ts`, inside `envObjectSchema`, next to `M365_GRAPH_ACTIONS_TOOLS_ENABLED`:

```ts
    // M365 tenant sync (wave 04). Dark by default; read at runtime by
    // isM365TenantSyncEnabled() in env.ts. Declared here so the format is
    // guarded — a typo reads as OFF at the runtime flag parser, silently
    // leaving the scheduler dark for an operator who believed they enabled it.
    M365_TENANT_SYNC_ENABLED: z.string().optional(),
    // Capacity dials for the sync worker/ticker. Format-guarded only: the
    // runtime accessors clamp, so a valid-but-silly value is an operator
    // choice, but a non-numeric value is a typo and must fail boot.
    M365_SYNC_CONCURRENCY: z.string().optional(),
    M365_SYNC_MAX_BACKLOG: z.string().optional(),
    M365_SYNC_TICK_BATCH: z.string().optional(),
```

and, inside the same `superRefine` that carries the `M365_GRAPH_ACTIONS_TOOLS_ENABLED` guard, immediately after it:

```ts
    const tenantSyncRaw = (data.M365_TENANT_SYNC_ENABLED ?? '').trim().toLowerCase();
    if (tenantSyncRaw && !boolValues.has(tenantSyncRaw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['M365_TENANT_SYNC_ENABLED'],
        message:
          'M365_TENANT_SYNC_ENABLED must be a boolean (true/false, 1/0, yes/no, on/off) when set. Defaults to false (the M365 tenant sync ticker and worker are dark).',
      });
    }
    for (const knob of ['M365_SYNC_CONCURRENCY', 'M365_SYNC_MAX_BACKLOG', 'M365_SYNC_TICK_BATCH'] as const) {
      const raw = (data[knob] ?? '').trim();
      if (raw && !/^\d+$/.test(raw)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [knob],
          message: `${knob} must be a positive integer when set.`,
        });
      }
    }
```

Add to `.env.example` and `deploy/.env.example`, in the M365 block after the graph-read executor keys:

```sh
# ---- Microsoft 365 tenant sync (posture snapshots) ----------------------
# Gates EVERY sync entry point: the 60s ticker, consent seeding, and the
# on-demand sync route. Default false. Turning it on is the only rollout
# step — the ticker seeds state rows for existing executable connections
# itself, staggered over the first hour.
M365_TENANT_SYNC_ENABLED=false
# Per-API-instance concurrency for the sync-domain job.
M365_SYNC_CONCURRENCY=4
# Ticker backpressure ceiling (waiting+prioritized+delayed+active).
M365_SYNC_MAX_BACKLOG=500
# Rows claimed per 60s tick. This is the capacity dial: BATCH x 1440 slots
# per day should run at <= 50% utilisation (spec §5.9).
M365_SYNC_TICK_BATCH=200
```

Add to the api service env block of `docker-compose.yml` (beside `M365_GRAPH_READ_TOOLS_ENABLED`) and of `deploy/docker-compose.prod.yml`:

```yaml
  M365_TENANT_SYNC_ENABLED: ${M365_TENANT_SYNC_ENABLED:-false}
  M365_SYNC_CONCURRENCY: ${M365_SYNC_CONCURRENCY:-4}
  M365_SYNC_MAX_BACKLOG: ${M365_SYNC_MAX_BACKLOG:-500}
  M365_SYNC_TICK_BATCH: ${M365_SYNC_TICK_BATCH:-200}
```

- [ ] **Step 4: Run the tests — they must PASS**

```bash
cd apps/api && npx vitest run src/config/env.m365Sync.test.ts src/config/validate.test.ts src/config/envComposeParity.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config/env.ts apps/api/src/config/validate.ts apps/api/src/config/env.m365Sync.test.ts apps/api/src/config/validate.test.ts .env.example docker-compose.yml deploy/.env.example deploy/docker-compose.prod.yml
git commit -m "$(cat <<'EOF'
feat(m365): add M365_TENANT_SYNC_ENABLED flag and sync capacity knobs

Dark-by-default gate for every tenant-sync entry point (spec §10 step 1),
plus M365_SYNC_CONCURRENCY / _MAX_BACKLOG / _TICK_BATCH. All four are
boot-validated for format (a typo must not silently read as OFF) and
threaded through both compose pairs so envComposeParity stays green.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 2: Sync budget family — `consumeM365SyncBudget`

Spec §5.10: "12 sync calls per hour per connection (continuation calls included), fail-closed on Redis error, same TTL discipline. The interactive 30/min and 2 000/day pools are untouched."

**Files:**
- Edit: `apps/api/src/services/m365ControlPlane/readActionBudget.ts`
- Edit: `apps/api/src/services/m365ControlPlane/readActionBudget.test.ts`

**Interfaces:**
- Consumes: `getRedis` from `apps/api/src/services/redis.ts` (existing).
- Produces (used by Task 3): `export const M365_SYNC_ACTIONS_PER_HOUR = 12;` and `export async function consumeM365SyncBudget(connectionId: string): Promise<M365ReadActionBudgetResult>`.

- [ ] **Step 1: Write the failing tests** — append to `readActionBudget.test.ts`:

```ts
describe('consumeM365SyncBudget (spec §5.10)', () => {
  it('uses a key prefix disjoint from the interactive pools, so 12/h cannot eat 30/min', async () => {
    const redis = mockRedis({ incrResults: [1, 1] });
    await consumeM365SyncBudget(CONNECTION_ID);
    const keys = redis.multi.mock.results.flatMap(() => redis.incr.mock.calls.map((c) => c[0] as string));
    expect(keys.every((k) => k.startsWith('m365-sync-budget-hour-'))).toBe(true);
    expect(keys.some((k) => k.startsWith('m365-read-budget-'))).toBe(false);
  });

  it('allows the 12th call in the hour and denies the 13th', async () => {
    mockRedis({ incrResults: [M365_SYNC_ACTIONS_PER_HOUR] });
    await expect(consumeM365SyncBudget(CONNECTION_ID)).resolves.toEqual({ allowed: true });

    mockRedis({ incrResults: [M365_SYNC_ACTIONS_PER_HOUR + 1] });
    const denied = await consumeM365SyncBudget(CONNECTION_ID);
    expect(denied.allowed).toBe(false);
    expect((denied as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect((denied as { retryAfterSeconds: number }).retryAfterSeconds).toBeLessThanOrEqual(3600);
  });

  it('fails CLOSED when Redis is unavailable', async () => {
    mockRedisUnavailable();
    await expect(consumeM365SyncBudget(CONNECTION_ID)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 3600,
    });
  });

  it('fails CLOSED when multi() returns null or an unparseable shape', async () => {
    mockRedis({ multiResult: null });
    expect((await consumeM365SyncBudget(CONNECTION_ID)).allowed).toBe(false);
    mockRedis({ incrResults: ['not-a-number'] });
    expect((await consumeM365SyncBudget(CONNECTION_ID)).allowed).toBe(false);
  });

  it('does not disturb the interactive budget: a sync call increments no read key', async () => {
    const redis = mockRedis({ incrResults: [1] });
    await consumeM365SyncBudget(CONNECTION_ID);
    expect(redis.incr).toHaveBeenCalledTimes(1);
  });
});
```

> Read the existing test file first and reuse **its** Redis mock helpers verbatim (`mockRedis` / `mockRedisUnavailable` or whatever they are named there) instead of inventing new ones — the point of this task is that the two families share one discipline.

- [ ] **Step 2: Run — must FAIL**

```bash
cd apps/api && npx vitest run src/services/m365ControlPlane/readActionBudget.test.ts
```

- [ ] **Step 3: Implement** — append to `readActionBudget.ts`:

```ts
/**
 * Whole-domain sync pull budget (spec §5.10). Deliberately its OWN key family:
 * a sync call is one executor round trip that may page 60 times inside the
 * executor, so it is nothing like an interactive read and must not consume, or
 * be consumed by, the 30/min + 2 000/day interactive pools.
 *
 * One fixed hourly window per connection. Continuation calls (sign-in activity,
 * W05) count against the same 12, which is the point: a tenant that needs ten
 * continuation pages must not get ten free Graph budgets.
 *
 * Fails CLOSED for the same reason the interactive budget does — a budget we
 * cannot answer is a denial, and the ticker retries the row next tick.
 */
export const M365_SYNC_ACTIONS_PER_HOUR = 12;

const SYNC_HOUR_KEY_TTL_SECONDS = 60 * 90;
const SYNC_DENY_RETRY_AFTER_SECONDS = 60 * 60;

function syncBudgetKey(connectionId: string, now: number): string {
  const hourWindow = Math.floor(now / 3_600_000);
  return `m365-sync-budget-hour-${connectionId}-${hourWindow}`;
}

function secondsRemainingInHour(now: number): number {
  return 3600 - Math.floor((now % 3_600_000) / 1_000);
}

export async function consumeM365SyncBudget(
  connectionId: string,
): Promise<M365ReadActionBudgetResult> {
  const now = Date.now();
  const key = syncBudgetKey(connectionId, now);

  try {
    const redis = getRedis();
    if (!redis) {
      console.error(
        `[readActionBudget] Redis unavailable, failing closed for sync connection=${connectionId}`,
      );
      return { allowed: false, retryAfterSeconds: SYNC_DENY_RETRY_AFTER_SECONDS };
    }

    const results = await redis.multi().incr(key).expire(key, SYNC_HOUR_KEY_TTL_SECONDS).exec();
    if (!results) {
      console.error(`[readActionBudget] Redis multi returned null for sync connection=${connectionId}`);
      return { allowed: false, retryAfterSeconds: SYNC_DENY_RETRY_AFTER_SECONDS };
    }

    const rawCount = results[0]?.[1];
    const count = typeof rawCount === 'number' ? rawCount : Number(rawCount ?? NaN);
    if (!Number.isFinite(count)) {
      console.error(
        `[readActionBudget] Unexpected sync multi() result shape for connection=${connectionId}:`,
        results,
      );
      return { allowed: false, retryAfterSeconds: SYNC_DENY_RETRY_AFTER_SECONDS };
    }

    if (count > M365_SYNC_ACTIONS_PER_HOUR) {
      return { allowed: false, retryAfterSeconds: secondsRemainingInHour(now) };
    }
    return { allowed: true };
  } catch (err) {
    console.error(
      `[readActionBudget] Redis error for sync connection=${connectionId}, failing closed:`,
      err,
    );
    return { allowed: false, retryAfterSeconds: SYNC_DENY_RETRY_AFTER_SECONDS };
  }
}
```

- [ ] **Step 4: Run — must PASS**

```bash
cd apps/api && npx vitest run src/services/m365ControlPlane/readActionBudget.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/readActionBudget.ts apps/api/src/services/m365ControlPlane/readActionBudget.test.ts
git commit -m "$(cat <<'EOF'
feat(m365): add fail-closed 12/hour sync budget family

consumeM365SyncBudget uses its own `m365-sync-budget-hour-` key prefix so
whole-domain pulls never consume (or are consumed by) the interactive
30/min + 2000/day pools (spec §5.10). Continuation calls count against the
same 12 by design.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 3: DB-free executor call helper — `callGraphReadExecutor`

Spec §5.1. `readActionService.ts` is refactored so the executor call is reachable from a background worker that holds no request context. **`executeM365ReadAction` must keep its exact current behaviour** — the existing suite (`readActionService.test.ts`, 390 lines) is not edited and must stay green as written.

**Files:**
- Edit: `apps/api/src/services/m365ControlPlane/readActionService.ts`
- Create: `apps/api/src/services/m365ControlPlane/readActionService.syncRoute.test.ts`
- Unchanged (must stay green): `apps/api/src/services/m365ControlPlane/readActionService.test.ts`

**Interfaces:**
- Consumes from W03: `M365SyncActionResult`, `GraphReadExecutorFailure`, the six sync branches of `M365ReadAction`, and `GraphReadExecutorClient.syncAction`.
- Consumes from Task 2: `consumeM365SyncBudget`, `M365_SYNC_ACTIONS_PER_HOUR`.
- Produces (used by Tasks 12/13 and by W05's on-demand route):

```ts
export interface M365ConnectionExecutionSnapshot {
  id: string; orgId: string; tenantId: string; consentGeneration: number;
  status: 'active' | 'degraded'; permissionManifestVersion: number;
  vaultRef: string; credentialVersion: string;
}
// M365SyncFailureCode (from @breeze/shared/m365) already carries
// 'continuation_invalid' and 'graph_throttled'; using it here rather than the
// narrower ReadActionFailureCode is what makes the continuation-restart branch
// in Task 13 type-check.
export type M365SyncCallFailureCode =
  | M365ReadActionRefusalCode | M365SyncFailureCode | 'sync_capacity';
export type M365SyncCallResult =
  | { ok: true; kind: 'sync'; result: M365SyncActionResult; executorMs: number }
  | { ok: false; code: M365SyncCallFailureCode; message: string; retryAfterSeconds?: number; executorMs: number };
export function syncFailureMessage(code: M365SyncCallFailureCode): string;   // total over the union
export interface CallGraphReadExecutorOptions {
  route: 'read' | 'sync';
  correlationId: string;
  actorId?: string;
  /** route 'sync' only: the label for m365_sync_executor_seconds{domain}. */
  domain?: M365SyncDomain;
  auditRequest?: RequestLike;
  recordEvent?: (request: RequestLike, input: M365ReadActionAuditInput) => void;
}
export async function callGraphReadExecutor(
  snapshot: M365ConnectionExecutionSnapshot,
  action: M365ReadAction,
  opts: CallGraphReadExecutorOptions,
): Promise<M365ReadActionServiceResult | M365SyncCallResult>;
export function connectionExecutionSnapshot(
  row: Pick<M365ConnectionRow, 'id' | 'orgId' | 'tenantId' | 'consentGeneration' | 'status' | 'permissionManifestVersion' | 'vaultRef' | 'credentialVersion'>,
): M365ConnectionExecutionSnapshot | null;   // null when the row is not executable
```

> **The audit decision (contract delta 1), restated where the implementer will read it:** `recordM365ReadActionEvent` DOES reach the database, but only through `writeAuditEvent`, which is fire-and-forget and whose `persistAuditLog` opens its own `runOutsideDbContext(() => withSystemDbAccessContext(...))` (`services/auditService.ts:54-79`). The helper therefore opens no context, inherits none, and holds none — safe to call from inside `runOutsideDbContext`. It stays in place for `route: 'read'` so the request path is unchanged, and is **omitted** for `route: 'sync'` because spec §7 wants exactly one `m365.sync.run` event per run, carrying counts that only exist after Phase C. `run.ts` writes that event (Task 13).

- [ ] **Step 1: Write the failing tests** — `readActionService.syncRoute.test.ts` (new). Clone the `vi.hoisted` / `vi.mock` preamble from `readActionService.test.ts` verbatim (same `../../db`, `../../middleware/auth`, `../aiTools`, `./runtimeConfig`, `./graphReadExecutorClient`, `../auditEvents` mocks), add `./readActionBudget`'s sync export to that mock, and add one more:

```ts
const { metricMocks } = vi.hoisted(() => ({ metricMocks: { executorSeconds: vi.fn() } }));
vi.mock('../m365Sync/metrics', () => ({ recordM365SyncExecutorSeconds: metricMocks.executorSeconds }));
```

then:

```ts
import { callGraphReadExecutor } from './readActionService';

const SNAPSHOT = {
  id: CONNECTION_ID, orgId: ORG_ID, tenantId: TENANT_ID, consentGeneration: 3,
  status: 'active' as const, permissionManifestVersion: 3,
  vaultRef: 'akv://vault.example/x/0123456789abcdef0123456789abcdef',
  credentialVersion: '0123456789abcdef0123456789abcdef',
};
const SYNC_ACTION = { type: 'm365.sync.users' } as const;
const SYNC_OK = {
  success: true, kind: 'sync', items: [{ id: 'u1' }], truncated: false,
  fetchedAt: '2026-09-08T00:00:00.000Z', sources: { users: 'ok' },
} as const;

describe('callGraphReadExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.loadConfig.mockReturnValue(RUNTIME_CONFIG);
    budgetMocks.consume.mockResolvedValue({ allowed: true });
    budgetMocks.consumeSync.mockResolvedValue({ allowed: true });
    executorMocks.createClient.mockReturnValue({
      executeReadAction: executorMocks.executeReadAction,
      syncAction: executorMocks.syncAction,
    });
  });

  it('never opens a DB context: no db.select, no withDbAccessContext, on either route', async () => {
    executorMocks.syncAction.mockResolvedValue(SYNC_OK);
    await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-1' });
    expect(dbMocks.selectSpy).not.toHaveBeenCalled();
    expect(contextMocks.withCaller).not.toHaveBeenCalled();
  });

  it('route sync consumes the SYNC budget, never the interactive one', async () => {
    executorMocks.syncAction.mockResolvedValue(SYNC_OK);
    await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-1' });
    expect(budgetMocks.consumeSync).toHaveBeenCalledWith(CONNECTION_ID);
    expect(budgetMocks.consume).not.toHaveBeenCalled();
  });

  it('route read consumes the INTERACTIVE budget and calls executeReadAction', async () => {
    executorMocks.executeReadAction.mockResolvedValue({ success: true, kind: 'collection', items: [], truncated: false });
    await callGraphReadExecutor(SNAPSHOT, { type: 'm365.org.get' }, { route: 'read', correlationId: 'c-2' });
    expect(budgetMocks.consume).toHaveBeenCalledWith(CONNECTION_ID);
    expect(budgetMocks.consumeSync).not.toHaveBeenCalled();
    expect(executorMocks.syncAction).not.toHaveBeenCalled();
  });

  it('a denied sync budget is a refusal, not an executor call (fail-closed)', async () => {
    budgetMocks.consumeSync.mockResolvedValue({ allowed: false, retryAfterSeconds: 900 });
    const result = await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-3' });
    expect(result).toMatchObject({ ok: false, code: 'read_rate_limited', retryAfterSeconds: 900 });
    expect(executorMocks.syncAction).not.toHaveBeenCalled();
  });

  it('returns the sync result verbatim with an executor duration', async () => {
    executorMocks.syncAction.mockResolvedValue(SYNC_OK);
    const result = await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-4' });
    expect(result).toMatchObject({ ok: true, kind: 'sync', result: SYNC_OK });
    expect((result as { executorMs: number }).executorMs).toBeGreaterThanOrEqual(0);
  });

  it('reads the failure discriminant off `code`, never off `errorCode` (W03 shape)', async () => {
    // A sync failure body is `{ success: false, code, retryAfterSeconds? }`.
    // Reading `.errorCode` here would silently produce `code: undefined` and a
    // "undefined" message — this test is the one that catches that.
    executorMocks.syncAction.mockResolvedValue({ success: false, code: 'sync_capacity', retryAfterSeconds: 30 });
    const capacity = await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-5' });
    expect(capacity).toMatchObject({ ok: false, code: 'sync_capacity', retryAfterSeconds: 30 });
    expect((capacity as { message: string }).message).not.toContain('undefined');

    executorMocks.syncAction.mockResolvedValue({ success: false, code: 'graph_throttled', retryAfterSeconds: 12 });
    const throttled = await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-6' });
    expect(throttled).toMatchObject({ ok: false, code: 'graph_throttled', retryAfterSeconds: 12 });
  });

  it('maps continuation_invalid without inventing a message', async () => {
    executorMocks.syncAction.mockResolvedValue({ success: false, code: 'continuation_invalid' });
    const result = await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-5b' });
    expect(result).toMatchObject({ ok: false, code: 'continuation_invalid' });
    expect((result as { message: string }).message).not.toContain('undefined');
  });

  it('labels the executor histogram with opts.domain, falling back to the action id', async () => {
    executorMocks.syncAction.mockResolvedValue(SYNC_OK);
    await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-5c', domain: 'users' });
    expect(metricMocks.executorSeconds.mock.calls[0]![0]).toBe('users');

    metricMocks.executorSeconds.mockClear();
    await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-5d' });
    expect(metricMocks.executorSeconds.mock.calls[0]![0]).toBe('m365.sync.users');
  });

  it('collapses a transport-level executor error to executor_unavailable on the sync route', async () => {
    executorMocks.syncAction.mockRejectedValue(new GraphReadExecutorClientError());
    const result = await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-7' });
    expect(result).toMatchObject({ ok: false, code: 'executor_unavailable' });
  });

  it('writes NO per-call audit event on the sync route (the run emits one m365.sync.run instead)', async () => {
    executorMocks.syncAction.mockResolvedValue(SYNC_OK);
    await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-8' });
    expect(auditMocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('writes the per-call audit event on the read route, exactly as the request path did', async () => {
    executorMocks.executeReadAction.mockResolvedValue({ success: true, kind: 'collection', items: [{}], truncated: false });
    await callGraphReadExecutor(SNAPSHOT, { type: 'm365.org.get' }, { route: 'read', correlationId: 'c-9', actorId: ACTOR_ID });
    expect(auditMocks.writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(auditMocks.writeAuditEvent.mock.calls[0]![1]).toMatchObject({
      orgId: ORG_ID,
      action: 'm365.customer_graph_read.action_executed',
      resourceId: CONNECTION_ID,
      details: { actionType: 'm365.org.get', outcome: 'ok', itemCount: 1, truncated: false },
      result: 'success',
    });
  });

  it('honours an injected recordEvent on the sync route without touching the default recorder', async () => {
    executorMocks.syncAction.mockResolvedValue(SYNC_OK);
    const recordEvent = vi.fn();
    await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-10', recordEvent });
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(auditMocks.writeAuditEvent).not.toHaveBeenCalled();
  });
});

describe('connectionExecutionSnapshot', () => {
  it.each(['pending-consent', 'verifying', 'suspended', 'revoked'])(
    'returns null for a %s connection (not executable)',
    (status) => {
      expect(connectionExecutionSnapshot({ ...ROW, status } as never)).toBeNull();
    },
  );

  it('returns null when the verified tenant is missing', () => {
    expect(connectionExecutionSnapshot({ ...ROW, tenantId: null } as never)).toBeNull();
  });

  it('coerces a null vaultRef/credentialVersion to "" rather than refusing a degraded row', () => {
    const snap = connectionExecutionSnapshot({ ...ROW, status: 'degraded', vaultRef: null, credentialVersion: null } as never);
    expect(snap).toMatchObject({ status: 'degraded', vaultRef: '', credentialVersion: '' });
  });
});

/**
 * The message map is TOTAL over M365SyncCallFailureCode. A code with no entry
 * would surface to an operator as the literal string "undefined", and `sources`
 * / `last_error` would then carry it into the audit trail — so the union is
 * pinned here, and the `_exhaustive` line makes ADDING a code to the union a
 * compile error until its message exists.
 */
describe('syncFailureMessage', () => {
  const ALL_CODES = [
    // M365ReadActionRefusalCode
    'tools_disabled', 'site_scope_denied', 'org_context_required',
    'connection_not_ready', 'read_rate_limited', 'executor_unavailable',
    // M365SyncFailureCode (= ReadActionFailureCode + continuation_invalid)
    'credential_unavailable', 'application_token_invalid', 'graph_permission_missing',
    'graph_license_required', 'graph_not_found', 'graph_throttled',
    'graph_response_too_large', 'graph_request_timeout', 'graph_transport_failed',
    'graph_response_invalid', 'continuation_invalid',
    // sync-only
    'sync_capacity',
  ] as const satisfies readonly M365SyncCallFailureCode[];

  // Compile-time half: if the union gains a member absent from ALL_CODES this
  // assignment stops type-checking, so the runtime loop below cannot go stale.
  type Missing = Exclude<M365SyncCallFailureCode, (typeof ALL_CODES)[number]>;
  const _exhaustive: Missing extends never ? true : never = true;

  it('has a non-empty, non-"undefined" message for EVERY code in the union', () => {
    expect(_exhaustive).toBe(true);
    for (const code of ALL_CODES) {
      const message = syncFailureMessage(code);
      expect(message, code).toBeTruthy();
      expect(message, code).not.toContain('undefined');
    }
  });
});
```

- [ ] **Step 2: Run — must FAIL** (`callGraphReadExecutor is not a function`):

```bash
cd apps/api && npx vitest run src/services/m365ControlPlane/readActionService.syncRoute.test.ts
```

- [ ] **Step 3: Implement** in `readActionService.ts`. Keep everything above `executeM365ReadAction` as-is; add:

```ts
import {
  isM365SyncActionId,
  type M365SyncActionResult,
  type M365SyncDomain,
  type M365SyncFailureCode,
} from '@breeze/shared/m365';
import { consumeM365SyncBudget } from './readActionBudget';
import { recordM365SyncExecutorSeconds } from '../m365Sync/metrics';   // added in Task 5
import type { M365ReadActionAuditInput } from './readActionMetrics';

/**
 * The immutable facts a background caller needs to issue one executor call and
 * to fence its own persistence afterwards (spec §5.1). Deliberately a VALUE,
 * not a row handle: the sync worker loads it in Phase A, commits, spends up to
 * 110 s in Graph with no DB context, and re-checks these fields in Phase C.
 *
 * `vaultRef`/`credentialVersion` are carried for caller-side fencing and
 * diagnostics only. The executor holds the sole credential and resolves it from
 * its own configuration — `executeReadAction`/`syncAction` send nothing but
 * `{correlationId, tenantId, action}` — so a NULL here is not a refusal.
 */
export interface M365ConnectionExecutionSnapshot {
  id: string;
  orgId: string;
  tenantId: string;
  consentGeneration: number;
  status: 'active' | 'degraded';
  permissionManifestVersion: number;
  vaultRef: string;
  credentialVersion: string;
}

export function connectionExecutionSnapshot(
  row: Pick<
    M365ConnectionRow,
    'id' | 'orgId' | 'tenantId' | 'consentGeneration' | 'status' | 'permissionManifestVersion' | 'vaultRef' | 'credentialVersion'
  > | undefined,
): M365ConnectionExecutionSnapshot | null {
  if (!row) return null;
  if (connectionNotReadyState(row)) return null;
  if (!row.orgId) return null;
  return {
    id: row.id,
    orgId: row.orgId,
    tenantId: row.tenantId as string,
    consentGeneration: row.consentGeneration,
    status: row.status as 'active' | 'degraded',
    permissionManifestVersion: row.permissionManifestVersion,
    vaultRef: row.vaultRef ?? '',
    credentialVersion: row.credentialVersion ?? '',
  };
}

export type M365SyncCallFailureCode =
  | M365ReadActionRefusalCode
  | M365SyncFailureCode
  | 'sync_capacity';

export type M365SyncCallResult =
  | { ok: true; kind: 'sync'; result: M365SyncActionResult; executorMs: number }
  | { ok: false; code: M365SyncCallFailureCode; message: string; retryAfterSeconds?: number; executorMs: number };

/**
 * Messages for the codes FAILURE_MESSAGES does not cover: the six refusal codes
 * (which the read path answers inline rather than through a map) plus the two
 * sync-only codes. Typed as a total Record over exactly that complement, so
 * adding a member to M365SyncCallFailureCode is a COMPILE error here rather
 * than an "undefined" shown to an operator and written into last_error.
 */
const SYNC_ONLY_MESSAGES: Record<
  Exclude<M365SyncCallFailureCode, ReadActionFailureCode>,
  string
> = {
  sync_capacity: 'The Microsoft 365 sync executor is at capacity. The sync will retry shortly.',
  continuation_invalid: 'The Microsoft 365 sign-in activity page cursor expired. The next run restarts the walk.',
  read_rate_limited: 'Microsoft 365 sync is rate limited for this connection. It will retry shortly.',
  executor_unavailable: 'Microsoft 365 Graph read is temporarily unavailable. Try again shortly.',
  tools_disabled: 'Microsoft 365 tenant sync is not enabled for this organization.',
  site_scope_denied: 'This Microsoft 365 connection is out of scope for the current site.',
  org_context_required: 'A Microsoft 365 sync run requires an organization context.',
  connection_not_ready: 'The Microsoft 365 connection is not ready to run — run Retest on the Microsoft 365 card.',
};

export function syncFailureMessage(code: M365SyncCallFailureCode): string {
  return code in SYNC_ONLY_MESSAGES
    ? SYNC_ONLY_MESSAGES[code as keyof typeof SYNC_ONLY_MESSAGES]
    : FAILURE_MESSAGES[code as ReadActionFailureCode];
}

export interface CallGraphReadExecutorOptions {
  /** 'read' = interactive budget + per-call audit; 'sync' = sync budget, no per-call audit. */
  route: 'read' | 'sync';
  correlationId: string;
  actorId?: string;
  /**
   * route 'sync' only. `m365_sync_executor_seconds` is labelled by DOMAIN, not
   * by action id, so the histogram lines up with `m365_sync_runs_total{domain}`
   * on one dashboard. Falls back to the action id when a caller omits it.
   */
  domain?: M365SyncDomain;
  auditRequest?: RequestLike;
  /**
   * Overrides the per-call recorder. The read route defaults to
   * `recordM365ReadActionEvent`; the sync route defaults to NOTHING, because
   * spec §7 wants exactly one `m365.sync.run` audit event per run and its
   * counts do not exist until Phase C has persisted.
   */
  recordEvent?: (request: RequestLike, input: M365ReadActionAuditInput) => void;
}

/**
 * One typed Graph call on behalf of a connection SNAPSHOT: budget, executor
 * client, metrics, and (read route only) the per-call audit event.
 *
 * Touches NO database. That is the whole point of extracting it — the sync
 * worker calls it inside `runOutsideDbContext` so no pooled connection is
 * pinned idle-in-transaction across a call that may run for 110 s
 * (#1105/#1697). A "by-org" variant that did its own lookup under ambient
 * context could not be wrapped that way at all: contextless DB access is a
 * denial, not a bypass, so the lookup would silently return zero rows.
 *
 * The audit call it does make is fire-and-forget and opens its own
 * runOutsideDbContext + system context (auditService.ts:54-79), so it neither
 * inherits nor holds the caller's context.
 */
export async function callGraphReadExecutor(
  snapshot: M365ConnectionExecutionSnapshot,
  action: M365ReadAction,
  opts: CallGraphReadExecutorOptions,
): Promise<M365ReadActionServiceResult | M365SyncCallResult> {
  const isSync = opts.route === 'sync';
  const request = opts.auditRequest ?? requestLikeFromSnapshot({});
  const auditBase = {
    orgId: snapshot.orgId,
    connectionId: snapshot.id,
    actionType: action.type,
    ...(opts.actorId ? { actorId: opts.actorId } : {}),
  };
  const record = opts.recordEvent ?? (isSync ? undefined : recordM365ReadActionEvent);

  const budget = isSync
    ? await consumeM365SyncBudget(snapshot.id)
    : await consumeM365ReadActionBudget(snapshot.id);
  if (!budget.allowed) {
    const refusal = {
      ok: false as const,
      code: 'read_rate_limited' as const,
      message: isSync
        ? syncFailureMessage('read_rate_limited')
        : 'Microsoft 365 Graph read actions are rate limited for this connection. Try again shortly.',
      retryAfterSeconds: budget.retryAfterSeconds,
    };
    return isSync ? { ...refusal, executorMs: 0 } : refusal;
  }

  const startedAt = Date.now();
  let executorResult;
  try {
    const client = runtimeClient(loadM365CustomerGraphReadRuntimeConfig());
    executorResult = isSync
      ? await client.syncAction({
        correlationId: opts.correlationId,
        tenantId: snapshot.tenantId,
        action: action as Parameters<typeof client.syncAction>[0]['action'],
      })
      : await client.executeReadAction({
        correlationId: opts.correlationId,
        tenantId: snapshot.tenantId,
        action,
      });
  } catch (error) {
    if (!(error instanceof GraphReadExecutorClientError)) throw error;
    const executorMs = Date.now() - startedAt;
    if (isSync) recordM365SyncExecutorSeconds(opts.domain ?? action.type, executorMs / 1000);
    record?.(request, { ...auditBase, outcome: 'executor_unavailable', itemCount: 0, truncated: false });
    const failure = {
      ok: false as const,
      code: 'executor_unavailable' as const,
      message: syncFailureMessage('executor_unavailable'),
    };
    return isSync ? { ...failure, executorMs } : failure;
  }

  const executorMs = Date.now() - startedAt;
  if (isSync) recordM365SyncExecutorSeconds(opts.domain ?? action.type, executorMs / 1000);

  if (!executorResult.success) {
    // The SYNC response discriminates on `code` (W03's GraphReadExecutorFailure);
    // the three interactive operations still discriminate on `errorCode`. Reading
    // the wrong one yields `undefined` with no type error at the `as never` edge,
    // which is why the sync-route test asserts the message has no "undefined".
    const code = isSync
      ? (executorResult as { code: M365SyncFailureCode | 'sync_capacity' }).code
      : (executorResult as { errorCode: ReadActionFailureCode }).errorCode;
    record?.(request, { ...auditBase, outcome: code as never, itemCount: 0, truncated: false });
    if (isSync) {
      return {
        ok: false,
        code: code as M365SyncCallFailureCode,
        message: syncFailureMessage(code as M365SyncCallFailureCode),
        retryAfterSeconds: executorResult.retryAfterSeconds,
        executorMs,
      };
    }
    return {
      ok: false,
      code: code as ReadActionFailureCode,
      message: FAILURE_MESSAGES[code as ReadActionFailureCode],
      retryAfterSeconds: executorResult.retryAfterSeconds,
    };
  }

  if (isSync) {
    const result = executorResult as M365SyncActionResult;
    record?.(request, {
      ...auditBase,
      outcome: 'ok',
      itemCount: result.items.length,
      truncated: result.truncated,
    });
    return { ok: true, kind: 'sync', result, executorMs };
  }

  if (executorResult.kind === 'collection') {
    record?.(request, { ...auditBase, outcome: 'ok', itemCount: executorResult.items.length, truncated: executorResult.truncated });
    return { ok: true, kind: 'collection', items: executorResult.items, truncated: executorResult.truncated };
  }
  record?.(request, { ...auditBase, outcome: 'ok', itemCount: 1, truncated: false });
  return { ok: true, kind: 'resource', resource: executorResult.resource };
}
```

Then reduce `executeM365ReadAction`'s tail (from the `const budget = await consumeM365ReadActionBudget(...)` line to the end of the function) to:

```ts
  const snapshot = connectionExecutionSnapshot(readyConnection);
  if (!snapshot) {
    // Unreachable: connectionNotReadyState above already refused every
    // non-executable shape. Kept as a fail-closed guard rather than a
    // non-null assertion, since this is the last gate before a Graph call.
    return {
      ok: false,
      code: 'connection_not_ready',
      message: connectionNotReadyMessage('missing'),
    };
  }

  return callGraphReadExecutor(snapshot, action, {
    route: 'read',
    correlationId: randomUUID(),
    actorId: auth.user.id,
    auditRequest,
  }) as Promise<M365ReadActionServiceResult>;
```

Also refuse a sync action id on the request route, so the split is enforced on both sides:

```ts
  if (isM365SyncActionId(action.type)) {
    return {
      ok: false,
      code: 'tools_disabled',
      message: 'Whole-tenant sync actions are not available to interactive Graph read tools.',
    };
  }
```
Place that immediately after the `isM365GraphReadToolsEnabledForOrg` gate (before any DB access).

- [ ] **Step 4: Run — both files, the new one green and the old one UNCHANGED and green**

```bash
cd apps/api && npx vitest run src/services/m365ControlPlane/readActionService.test.ts src/services/m365ControlPlane/readActionService.syncRoute.test.ts
git diff --stat -- apps/api/src/services/m365ControlPlane/readActionService.test.ts   # must be empty
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/readActionService.ts apps/api/src/services/m365ControlPlane/readActionService.syncRoute.test.ts
git commit -m "$(cat <<'EOF'
refactor(m365): extract DB-free callGraphReadExecutor from readActionService

Spec §5.1. The helper takes an immutable connection snapshot, picks the
budget family from opts.route, calls executeReadAction or syncAction, and
records metrics; executeM365ReadAction becomes a thin wrapper with
byte-identical behaviour (its suite is unchanged and green).

The per-call audit event stays on the READ route only: spec §7 wants exactly
one m365.sync.run event per sync run, carrying counts that do not exist at
executor-call time. The helper opens no DB context — the audit path it does
use is fire-and-forget and opens its own (auditService.ts:54-79) — so the
sync worker can call it inside runOutsideDbContext.

A sync failure discriminates on `code` (W03's GraphReadExecutorFailure), not
on the `errorCode` the three interactive operations use; reading the wrong
field would surface as the literal string "undefined" in last_error, so a test
pins it. syncFailureMessage is TOTAL over M365SyncCallFailureCode, enforced at
compile time by a Record over the union's complement.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 4: `services/m365Sync/types.ts` + `hash.ts`

Spec §5.3, §5.4 (canonical projection and `core_hash`), §6 (outcome vocabulary).

**Files:**
- Create: `apps/api/src/services/m365Sync/types.ts`
- Create: `apps/api/src/services/m365Sync/hash.ts`
- Create: `apps/api/src/services/m365Sync/hash.test.ts`

**Interfaces:**
- Consumes from W03: `M365SyncDomain`, `M365_SYNC_DOMAINS`, `M365SyncActionId`, `M365SyncSourceState`, `M365SyncActionResult`.
- Produces (used by every later task and by W05):

```ts
// types.ts
export interface M365SyncJobData { orgId: string; domain: M365SyncDomain; generation: number;
  connectionId: string; tenantId: string; consentGeneration: number; priority: 1 | 10 }
export const m365SyncJobDataSchema: z.ZodType<M365SyncJobData>;
export type M365SyncOutcome = 'success' | 'partial' | 'needs_consent' | 'throttled' | 'error';
/** Defined ONCE, here. Nothing else in the wave may redeclare it. */
export type M365SyncRunResult = M365SyncOutcome | 'fenced' | 'noop' | 'partial-continue';
export interface PersistContext { orgId: string; tenantId: string; connectionId: string;
  generation: number; existing: Map<string, { coreHash: string; isStale: boolean }>; now: Date }
export interface DomainPersistResult { inserted: number; updated: number; stale: number;
  unchanged: number; counts: Record<string, number>; complete: boolean }
export type M365DomainPersister = (ctx: PersistContext, result: M365SyncActionResult) => Promise<DomainPersistResult>;
/** Signals `applyCadence` reads. All six fields are always populated by run.ts. */
export interface CadenceSignals { truncated: boolean; latencyMs: number; capacity: boolean;
  unlicensed: boolean; authFailure: boolean; now: Date }
export const M365_SYNC_LEASE_MINUTES = 20;
export const M365_SYNC_PERSIST_CHUNK_SIZE = 1000;
// W04 value: ['users','intune_devices','ca_policies','skus'].
// W05 SETS THIS TO `M365_SYNC_DOMAINS` when it registers persistSigninActivity
// and persistSecureScore, and inverts the two claim-SQL assertions in
// claim.sql.test.ts that currently assert those two domains are NOT seeded.
export const M365_SYNC_IMPLEMENTED_DOMAINS: readonly M365SyncDomain[];
export const M365_SYNC_PRIMARY_SOURCE_KEY: Record<M365SyncDomain, string>;
export const M365_SYNC_DOMAIN_ACTION_ID: Record<M365SyncDomain, M365SyncActionId>;
/**
 * The SINGLE action builder. Nothing else in the wave constructs an
 * `m365.sync.*` action literal — Phase B calls this with both options and lets
 * the builder drop the ones the action does not accept.
 */
export function m365SyncActionFor(domain: M365SyncDomain, opts?: { continuation?: string | null; backfill?: boolean }): M365ReadAction;
// hash.ts
export function canonicalHash(record: Record<string, unknown>): string;   // SHA-256 hex
export function canonicalize(value: unknown): unknown;                     // exported for tests
```

- [ ] **Step 1: Write the failing test** — `hash.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canonicalHash, canonicalize } from './hash';

describe('canonicalHash (spec §5.4)', () => {
  it('is insensitive to object key ORDER at the top level', () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });

  it('is insensitive to key order at EVERY nesting depth', () => {
    const left = { outer: { z: { q: 1, p: 2 }, a: 3 } };
    const right = { outer: { a: 3, z: { p: 2, q: 1 } } };
    expect(canonicalHash(left)).toBe(canonicalHash(right));
  });

  it('sorts arrays of primitives, so a Graph reordering of assignedLicenses is not a change', () => {
    expect(canonicalHash({ skus: ['b', 'a', 'c'] })).toBe(canonicalHash({ skus: ['c', 'b', 'a'] }));
  });

  it('sorts arrays of OBJECTS by their canonical string', () => {
    const a = { roles: [{ id: '2', name: 'b' }, { id: '1', name: 'a' }] };
    const b = { roles: [{ id: '1', name: 'a' }, { id: '2', name: 'b' }] };
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it('sorts objects nested INSIDE array elements too', () => {
    const a = { roles: [{ name: 'a', id: '1' }] };
    const b = { roles: [{ id: '1', name: 'a' }] };
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it('DISTINGUISHES a real value change (this is not a constant function)', () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
    expect(canonicalHash({ skus: ['a'] })).not.toBe(canonicalHash({ skus: ['a', 'a'] }));
    expect(canonicalHash({ enabled: true })).not.toBe(canonicalHash({ enabled: false }));
    expect(canonicalHash({ a: '1' })).not.toBe(canonicalHash({ a: 1 }));
  });

  it('treats undefined and a missing key as null, so a dropped optional field is stable', () => {
    expect(canonicalize({ a: undefined })).toEqual({ a: null });
    expect(canonicalHash({ a: undefined, b: 1 })).toBe(canonicalHash({ a: null, b: 1 }));
  });

  it('preserves explicit null and does not collapse it into an empty string', () => {
    expect(canonicalHash({ a: null })).not.toBe(canonicalHash({ a: '' }));
  });

  it('returns 64 lowercase hex characters', () => {
    expect(canonicalHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across calls (no Map/Set iteration leaking in)', () => {
    const record = { z: [3, 1, 2], a: { b: [{ y: 1 }, { x: 2 }] } };
    expect(canonicalHash(record)).toBe(canonicalHash(record));
  });
});
```

- [ ] **Step 2: Run — must FAIL**

```bash
cd apps/api && npx vitest run src/services/m365Sync/hash.test.ts
```

- [ ] **Step 3: Implement**

`apps/api/src/services/m365Sync/hash.ts`:

```ts
import { createHash } from 'node:crypto';

/**
 * Canonical form for change detection (spec §5.4): object keys sorted, arrays
 * sorted by each element's own canonical string, `undefined` normalised to
 * null.
 *
 * Sorting arrays by canonical string handles both cases the spec names —
 * arrays of primitives and arrays of objects — with one rule, so a role list
 * and a sku-id list cannot drift apart in behaviour. It is a deliberate
 * *semantic* choice, not just a stabiliser: Graph returns these collections in
 * an order it does not promise, so an order-sensitive hash would rewrite every
 * row on every run and destroy the "steady-state writes ~= 0" property this
 * whole design rests on.
 *
 * Only JSON-primitive leaves may appear here. Projections are executor JSON,
 * so a Date or a Map would be a bug; both would canonicalise to `{}` and
 * silently collapse distinct values, which is why nothing in this module
 * accepts a row object straight off Drizzle.
 */
export function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .sort((a, b) => {
        const left = stableKey(a);
        const right = stableKey(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

function stableKey(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 hex of the canonical projection. 64 lowercase hex chars, matching `core_hash char(64)`. */
export function canonicalHash(record: Record<string, unknown>): string {
  return createHash('sha256').update(stableKey(canonicalize(record))).digest('hex');
}
```

`apps/api/src/services/m365Sync/types.ts`:

```ts
import { z } from 'zod';
import {
  M365_SYNC_DOMAINS,
  type M365ReadAction,
  type M365SyncActionId,
  type M365SyncActionResult,
  type M365SyncDomain,
} from '@breeze/shared/m365';

/** Payload of one `sync-domain` job. Every field is an immutable fact captured at claim time. */
export interface M365SyncJobData {
  orgId: string;
  domain: M365SyncDomain;
  generation: number;
  connectionId: string;
  tenantId: string;
  consentGeneration: number;
  priority: 1 | 10;
}

/**
 * Parsed at the top of the processor. A malformed payload (a legacy job left in
 * Redis across a deploy, a hand-poked entry) must fail UNRECOVERABLY rather
 * than burn three attempts and three Sentry events on the same bad shape.
 */
export const m365SyncJobDataSchema: z.ZodType<M365SyncJobData> = z.object({
  orgId: z.string().uuid(),
  domain: z.enum(M365_SYNC_DOMAINS),
  generation: z.number().int().min(1),
  connectionId: z.string().uuid(),
  tenantId: z.string().min(1).max(64),
  consentGeneration: z.number().int().min(0),
  priority: z.union([z.literal(1), z.literal(10)]),
}).strict();

/** Spec §6's outcome vocabulary, mirroring the `m365_sync_status` enum. Persisted. */
export type M365SyncOutcome = 'success' | 'partial' | 'needs_consent' | 'throttled' | 'error';
/**
 * Control flow only — NEVER persisted to `last_status`, which is the
 * `m365_sync_status` enum above. `fenced` = discarded at Phase C; `noop` =
 * nothing to do (flag off, row gone, domain not implemented);
 * `partial-continue` = the continuation cursor was rejected, the walk has been
 * restarted, and the completion writer deliberately left `last_status` alone.
 *
 * Declared HERE and nowhere else in the wave.
 */
export type M365SyncRunResult = M365SyncOutcome | 'fenced' | 'noop' | 'partial-continue';

export interface PersistContext {
  orgId: string;
  tenantId: string;
  connectionId: string;
  generation: number;
  /** graph_id -> existing (core_hash, is_stale), read once in Phase A. */
  existing: Map<string, { coreHash: string; isStale: boolean }>;
  now: Date;
}

export interface DomainPersistResult {
  inserted: number;
  updated: number;
  stale: number;
  unchanged: number;
  /** Counters computed IN MEMORY during Phase C; stored in last_counts, feeds the W05 rollup (spec §5.9). */
  counts: Record<string, number>;
  /** Primary source `ok` AND not truncated — the only shape that may mark stale rows (spec §5.4). */
  complete: boolean;
}

export type M365DomainPersister = (
  ctx: PersistContext,
  result: M365SyncActionResult,
) => Promise<DomainPersistResult>;

/**
 * What `applyCadence` gets to reason about (spec §5.7). Declared here rather
 * than in cadence.ts so run.ts can build it without importing the seam's module
 * for a type, and re-exported from cadence.ts for W05's convenience.
 *
 * All six fields are ALWAYS populated — `unlicensed` and `authFailure` are
 * `false` rather than absent on the paths where they cannot apply, so W05
 * cannot accidentally read `undefined` as "not unlicensed" on one branch and as
 * a missing signal on another.
 */
export interface CadenceSignals {
  truncated: boolean;
  latencyMs: number;
  capacity: boolean;
  /** `sources.signInActivity === 'unlicensed'`; always false for non-sign-in domains. */
  unlicensed: boolean;
  /** Failure code is in the auth-failure set. Deliberately EXCLUDES `graph_permission_missing`, which is `needs_consent`, not a dead credential. */
  authFailure: boolean;
  now: Date;
}

export const M365_SYNC_LEASE_MINUTES = 20;
export const M365_SYNC_PERSIST_CHUNK_SIZE = 1000;

/**
 * Domains this wave can actually persist. `reconcileEligibleConnections` seeds
 * ONLY these: seeding `signin_activity`/`secure_score` before W05 lands their
 * persisters would make them claimable with nothing to run, so they would be
 * re-claimed every tick forever and burn ticker slots.
 *
 * W05 SETS THIS TO `M365_SYNC_DOMAINS` and, in the same PR, inverts the two
 * `expect(params).not.toContain(...)` assertions in `claim.sql.test.ts` that
 * are marked "W05 inverts this".
 */
export const M365_SYNC_IMPLEMENTED_DOMAINS: readonly M365SyncDomain[] = [
  'users', 'intune_devices', 'ca_policies', 'skus',
] as const;

/**
 * The `sources` key that decides a domain's outcome (spec §6). A
 * `permission_missing` here is `needs_consent`; on any OTHER key it is a
 * secondary-source failure and the run is `partial`.
 */
export const M365_SYNC_PRIMARY_SOURCE_KEY: Record<M365SyncDomain, string> = {
  users: 'users',
  signin_activity: 'signInActivity',
  intune_devices: 'managedDevices',
  ca_policies: 'policies',
  skus: 'subscribedSkus',
  secure_score: 'secureScores',
};

export const M365_SYNC_DOMAIN_ACTION_ID: Record<M365SyncDomain, M365SyncActionId> = {
  users: 'm365.sync.users',
  signin_activity: 'm365.sync.signin_activity',
  intune_devices: 'm365.sync.intune_devices',
  ca_policies: 'm365.sync.ca_policies',
  skus: 'm365.sync.skus',
  secure_score: 'm365.sync.secure_score',
};

/**
 * The SINGLE action builder for every `m365.sync.*` call. Phase B always passes
 * BOTH options and lets this function drop the ones an action does not accept,
 * so no caller has to know which domain is resumable and which is backfillable.
 *
 * `backfill` is therefore already wired in W04 even though `secure_score` has
 * no persister yet: it is harmless while the domain is unregistered, and W05
 * gets a working builder rather than a call site to go and edit.
 */
export function m365SyncActionFor(
  domain: M365SyncDomain,
  opts: { continuation?: string | null; backfill?: boolean } = {},
): M365ReadAction {
  const type = M365_SYNC_DOMAIN_ACTION_ID[domain];
  if (type === 'm365.sync.signin_activity' && opts.continuation) {
    return { type, continuation: opts.continuation } as M365ReadAction;
  }
  if (type === 'm365.sync.secure_score' && opts.backfill) {
    return { type, backfill: true } as M365ReadAction;
  }
  return { type } as M365ReadAction;
}

export type { M365SyncActionResult, M365SyncDomain };
```

- [ ] **Step 4: Run — must PASS**

```bash
cd apps/api && npx vitest run src/services/m365Sync/hash.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/types.ts apps/api/src/services/m365Sync/hash.ts apps/api/src/services/m365Sync/hash.test.ts
git commit -m "$(cat <<'EOF'
feat(m365): add sync core types and canonical change-detection hash

canonicalHash sorts object keys at every depth and sorts arrays by each
element's canonical string, so a Graph reordering of assignedLicenses or
adminRoles is not a change (spec §5.4). Without that, every row would be
rewritten on every run and the steady-state-zero-writes property would be
gone.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 5: `services/m365Sync/metrics.ts` + `/metrics` registration

Spec §7 (exact names). Recorder-seam pattern copied from `services/retentionMetrics.ts`: `jobs/*` and `services/m365Sync/*` emit through settable recorders so they never import `routes/metrics` (which would close an import cycle); `routes/metrics.ts` binds the real instruments once at startup.

**Files:**
- Create: `apps/api/src/services/m365Sync/metrics.ts`
- Create: `apps/api/src/services/m365Sync/metrics.test.ts`
- Edit: `apps/api/src/routes/metrics.ts`

**Interfaces:**
- Produces (used by Tasks 3, 13, 14 and by W05's link reconciliation):

```ts
export function recordM365SyncRun(domain: M365SyncDomain, outcome: M365SyncOutcome): void;
export function recordM365SyncItems(domain: M365SyncDomain, kind: 'insert'|'update'|'stale'|'unchanged', count: number): void;
export function recordM365SyncExecutorSeconds(domain: string, seconds: number): void;   // label is the DOMAIN
export function setM365SyncDueBacklog(value: number): void;
export function setM365SyncQueueDepth(value: number): void;
export function setM365SyncTickerUtilisation(value: number): void;
export function recordM365SyncTickerSkipped(): void;
export function recordM365SyncFenced(): void;
export function recordM365SyncLinkAmbiguous(count: number): void;
export function setM365SyncMetricsRecorder(next: Partial<M365SyncMetricsRecorder> | null | undefined): void;
export function registerM365SyncMetrics(registry: Registry): void;
```

> Metric names are the contract's, unprefixed (`m365_sync_runs_total`), deliberately unlike the neighbouring `breeze_m365_graph_read_actions_total`. Do not "fix" the prefix — spec §7 and the shared contract both pin these strings and W06's dashboards are written against them.
>
> **`metrics.test.ts` is the SINGLE name-contract suite for this surface.** W06 adds its `breeze_`-prefixed-twin negative assertion (no `breeze_m365_sync_*` series is ever registered) to THIS file — it does not create a second metrics suite. Keep the exact-name `toEqual([...])` list intact so that addition has something to attach to.
>
> Known limitation, unchanged by this wave: `routes/metrics.ts` is the only registration site, and `src/worker.ts` renders a scrape without importing it, so on a split `BREEZE_ROLE=worker` process these series are no-ops. Every existing `register*PrometheusMetrics` has the same shape and `BREEZE_ROLE` defaults to `all`. Not in scope here.

- [ ] **Step 1: Write the failing test** — `metrics.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Registry } from 'prom-client';
import {
  recordM365SyncFenced, recordM365SyncItems, recordM365SyncRun, recordM365SyncTickerSkipped,
  registerM365SyncMetrics, setM365SyncDueBacklog, setM365SyncMetricsRecorder,
  setM365SyncQueueDepth, setM365SyncTickerUtilisation, recordM365SyncExecutorSeconds,
  recordM365SyncLinkAmbiguous,
} from './metrics';

describe('m365 sync metrics (spec §7)', () => {
  beforeEach(() => setM365SyncMetricsRecorder(null));

  it('is a silent no-op before registration, so importing the module cannot throw at boot', () => {
    expect(() => {
      recordM365SyncRun('users', 'success');
      recordM365SyncItems('users', 'insert', 5);
      setM365SyncDueBacklog(3);
      recordM365SyncFenced();
      recordM365SyncLinkAmbiguous(2);
    }).not.toThrow();
  });

  it('registers exactly the nine contract series under their exact names', async () => {
    const registry = new Registry();
    registerM365SyncMetrics(registry);
    const names = (await registry.getMetricsAsJSON()).map((m) => m.name).sort();
    expect(names).toEqual([
      'm365_sync_due_backlog',
      'm365_sync_executor_seconds',
      'm365_sync_fenced_total',
      'm365_sync_items',
      'm365_sync_link_ambiguous_total',
      'm365_sync_queue_depth',
      'm365_sync_runs_total',
      'm365_sync_ticker_skipped_total',
      'm365_sync_ticker_utilisation',
    ]);
  });

  it('is idempotent: registering twice against the same registry does not throw', () => {
    const registry = new Registry();
    registerM365SyncMetrics(registry);
    expect(() => registerM365SyncMetrics(registry)).not.toThrow();
  });

  it('labels runs by domain and outcome, and items by domain and kind', async () => {
    const registry = new Registry();
    registerM365SyncMetrics(registry);
    recordM365SyncRun('intune_devices', 'partial');
    recordM365SyncItems('intune_devices', 'stale', 7);
    const scrape = await registry.metrics();
    expect(scrape).toContain('m365_sync_runs_total{domain="intune_devices",outcome="partial"} 1');
    expect(scrape).toContain('m365_sync_items{domain="intune_devices",kind="stale"} 7');
  });

  it('publishes the gauges as SET values, not increments', async () => {
    const registry = new Registry();
    registerM365SyncMetrics(registry);
    setM365SyncQueueDepth(11);
    setM365SyncQueueDepth(4);
    setM365SyncTickerUtilisation(0.25);
    setM365SyncDueBacklog(120);
    const scrape = await registry.metrics();
    expect(scrape).toContain('m365_sync_queue_depth 4');
    expect(scrape).toContain('m365_sync_ticker_utilisation 0.25');
    expect(scrape).toContain('m365_sync_due_backlog 120');
  });

  it('observes executor latency into a histogram labelled by DOMAIN, so it joins m365_sync_runs_total', async () => {
    const registry = new Registry();
    registerM365SyncMetrics(registry);
    recordM365SyncExecutorSeconds('users', 2.5);
    const scrape = await registry.metrics();
    expect(scrape).toContain('m365_sync_executor_seconds_count{domain="users"} 1');
    // An action id would split the series away from every other m365_sync_*
    // metric, which are all labelled by domain.
    expect(scrape).not.toContain('domain="m365.sync.users"');
  });

  it('drops a non-finite or negative count rather than poisoning a counter', async () => {
    const registry = new Registry();
    registerM365SyncMetrics(registry);
    recordM365SyncItems('users', 'insert', Number.NaN);
    recordM365SyncItems('users', 'insert', -3);
    recordM365SyncItems('users', 'insert', 2);
    expect(await registry.metrics()).toContain('m365_sync_items{domain="users",kind="insert"} 2');
  });

  it('counts ticker skips and fences', async () => {
    const registry = new Registry();
    registerM365SyncMetrics(registry);
    recordM365SyncTickerSkipped();
    recordM365SyncFenced();
    recordM365SyncFenced();
    const scrape = await registry.metrics();
    expect(scrape).toContain('m365_sync_ticker_skipped_total 1');
    expect(scrape).toContain('m365_sync_fenced_total 2');
  });
});
```

- [ ] **Step 2: Run — must FAIL**

```bash
cd apps/api && npx vitest run src/services/m365Sync/metrics.test.ts
```

- [ ] **Step 3: Implement** — `apps/api/src/services/m365Sync/metrics.ts`:

```ts
import { Counter, Gauge, Histogram, type Registry } from 'prom-client';
import type { M365SyncDomain } from '@breeze/shared/m365';
import type { M365SyncOutcome } from './types';

/**
 * Prometheus surface for the tenant-sync engine (spec §7). Same shape as
 * services/retentionMetrics.ts and services/actionIntents/metrics.ts: a
 * settable recorder so services/ and jobs/ emit without importing
 * routes/metrics (which would close an import cycle), plus one
 * `register*` the route calls at startup. Until that call every record* is a
 * silent no-op — importing this module must never be able to fail a boot.
 *
 * Names are UNPREFIXED on purpose (`m365_sync_runs_total`, not
 * `breeze_m365_sync_runs_total`), unlike the neighbouring
 * `breeze_m365_graph_read_actions_total`: the spec and the wave contract pin
 * these exact strings and the runbook/dashboards are written against them.
 */
export type M365SyncItemKind = 'insert' | 'update' | 'stale' | 'unchanged';

export interface M365SyncMetricsRecorder {
  onRun: (domain: M365SyncDomain, outcome: M365SyncOutcome) => void;
  onItems: (domain: M365SyncDomain, kind: M365SyncItemKind, count: number) => void;
  /** `domain` is an M365SyncDomain string; the histogram label is the domain, never the action id. */
  onExecutorSeconds: (domain: string, seconds: number) => void;
  onDueBacklog: (value: number) => void;
  onQueueDepth: (value: number) => void;
  onTickerUtilisation: (value: number) => void;
  onTickerSkipped: () => void;
  onFenced: () => void;
  onLinkAmbiguous: (count: number) => void;
}

const noop = () => {};
const emptyRecorder: M365SyncMetricsRecorder = {
  onRun: noop, onItems: noop, onExecutorSeconds: noop, onDueBacklog: noop,
  onQueueDepth: noop, onTickerUtilisation: noop, onTickerSkipped: noop,
  onFenced: noop, onLinkAmbiguous: noop,
};
let recorder: M365SyncMetricsRecorder = emptyRecorder;

export function setM365SyncMetricsRecorder(
  next: Partial<M365SyncMetricsRecorder> | null | undefined,
): void {
  recorder = { ...emptyRecorder, ...(next ?? {}) };
}

/** A count that arithmetic could have made NaN must not poison a monotonic counter. */
function safeCount(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function recordM365SyncRun(domain: M365SyncDomain, outcome: M365SyncOutcome): void {
  recorder.onRun(domain, outcome);
}
export function recordM365SyncItems(domain: M365SyncDomain, kind: M365SyncItemKind, count: number): void {
  const safe = safeCount(count);
  if (safe === null || safe === 0) return;
  recorder.onItems(domain, kind, safe);
}
export function recordM365SyncExecutorSeconds(domain: string, seconds: number): void {
  const safe = safeCount(seconds);
  if (safe === null) return;
  recorder.onExecutorSeconds(domain, safe);
}
export function setM365SyncDueBacklog(value: number): void {
  const safe = safeCount(value);
  if (safe !== null) recorder.onDueBacklog(safe);
}
export function setM365SyncQueueDepth(value: number): void {
  const safe = safeCount(value);
  if (safe !== null) recorder.onQueueDepth(safe);
}
export function setM365SyncTickerUtilisation(value: number): void {
  const safe = safeCount(value);
  if (safe !== null) recorder.onTickerUtilisation(safe);
}
export function recordM365SyncTickerSkipped(): void { recorder.onTickerSkipped(); }
export function recordM365SyncFenced(): void { recorder.onFenced(); }
export function recordM365SyncLinkAmbiguous(count: number): void {
  const safe = safeCount(count);
  if (safe === null || safe === 0) return;
  recorder.onLinkAmbiguous(safe);
}

const RUNS = 'm365_sync_runs_total';
const ITEMS = 'm365_sync_items';
const EXECUTOR_SECONDS = 'm365_sync_executor_seconds';
const DUE_BACKLOG = 'm365_sync_due_backlog';
const QUEUE_DEPTH = 'm365_sync_queue_depth';
const TICKER_UTILISATION = 'm365_sync_ticker_utilisation';
const TICKER_SKIPPED = 'm365_sync_ticker_skipped_total';
const FENCED = 'm365_sync_fenced_total';
const LINK_AMBIGUOUS = 'm365_sync_link_ambiguous_total';

export function registerM365SyncMetrics(registry: Registry): void {
  const runs = (registry.getSingleMetric(RUNS) as Counter<'domain' | 'outcome'> | undefined)
    ?? new Counter({ name: RUNS, help: 'Completed m365 sync-domain runs by domain and outcome', labelNames: ['domain', 'outcome'] as const, registers: [registry] });
  const items = (registry.getSingleMetric(ITEMS) as Counter<'domain' | 'kind'> | undefined)
    ?? new Counter({ name: ITEMS, help: 'Entity rows written by an m365 sync run, by domain and kind (insert|update|stale|unchanged)', labelNames: ['domain', 'kind'] as const, registers: [registry] });
  const executorSeconds = (registry.getSingleMetric(EXECUTOR_SECONDS) as Histogram<'domain'> | undefined)
    ?? new Histogram({ name: EXECUTOR_SECONDS, help: 'Round-trip seconds for one m365 sync executor call, labelled by domain', labelNames: ['domain'] as const, buckets: [0.5, 1, 2.5, 5, 10, 20, 40, 60, 90, 120], registers: [registry] });
  const dueBacklog = (registry.getSingleMetric(DUE_BACKLOG) as Gauge<string> | undefined)
    ?? new Gauge({ name: DUE_BACKLOG, help: 'm365_sync_state rows whose next_sync_at is in the past at the last tick', registers: [registry] });
  const queueDepth = (registry.getSingleMetric(QUEUE_DEPTH) as Gauge<string> | undefined)
    ?? new Gauge({ name: QUEUE_DEPTH, help: 'm365-sync queue depth (waiting+prioritized+delayed+active) at the last tick', registers: [registry] });
  const tickerUtilisation = (registry.getSingleMetric(TICKER_UTILISATION) as Gauge<string> | undefined)
    ?? new Gauge({ name: TICKER_UTILISATION, help: 'Fraction of the tick batch actually claimed at the last tick (spec §5.9 target <= 0.5)', registers: [registry] });
  const tickerSkipped = (registry.getSingleMetric(TICKER_SKIPPED) as Counter<string> | undefined)
    ?? new Counter({ name: TICKER_SKIPPED, help: 'Ticks that exited on backpressure without claiming', registers: [registry] });
  const fenced = (registry.getSingleMetric(FENCED) as Counter<string> | undefined)
    ?? new Counter({ name: FENCED, help: 'Sync results discarded at Phase C because generation/connection/tenant/consent changed', registers: [registry] });
  const linkAmbiguous = (registry.getSingleMetric(LINK_AMBIGUOUS) as Counter<string> | undefined)
    ?? new Counter({ name: LINK_AMBIGUOUS, help: 'Intune device rows skipped during link reconciliation because the match was not 1:1', registers: [registry] });

  setM365SyncMetricsRecorder({
    onRun: (domain, outcome) => runs.labels(domain, outcome).inc(),
    onItems: (domain, kind, count) => items.labels(domain, kind).inc(count),
    onExecutorSeconds: (domain, seconds) => executorSeconds.labels(domain).observe(seconds),
    onDueBacklog: (value) => dueBacklog.set(value),
    onQueueDepth: (value) => queueDepth.set(value),
    onTickerUtilisation: (value) => tickerUtilisation.set(value),
    onTickerSkipped: () => tickerSkipped.inc(),
    onFenced: () => fenced.inc(),
    onLinkAmbiguous: (count) => linkAmbiguous.inc(count),
  });
}
```

In `apps/api/src/routes/metrics.ts`, add the import beside `registerM365GraphActionsPrometheusCounter` and the call beside `registerRetentionPrometheusMetrics(register)`:

Import line (beside the other `register*` imports, around line 57):

```ts
import { registerM365SyncMetrics } from '../services/m365Sync/metrics';
```

Call site (in the block that already reads `registerActionIntentPrometheusCounter(register);`
/ `registerRetentionPrometheusMetrics(register);`, around line 106):

```ts
registerM365SyncMetrics(register);
```

- [ ] **Step 4: Run — must PASS**

```bash
cd apps/api && npx vitest run src/services/m365Sync/metrics.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/metrics.ts apps/api/src/services/m365Sync/metrics.test.ts apps/api/src/routes/metrics.ts
git commit -m "$(cat <<'EOF'
feat(m365): add the m365_sync_* Prometheus surface

All nine series from spec §7 behind the retentionMetrics recorder seam, so
services/ and jobs/ emit without importing routes/metrics. Names are
unprefixed by contract and registerM365SyncMetrics is the single registrar;
metrics.test.ts is the single name-contract suite (W06 adds its breeze_-twin
negative assertion there). m365_sync_executor_seconds is labelled by DOMAIN so
it joins m365_sync_runs_total on one dashboard. Counts that arithmetic could
have made NaN are dropped rather than poisoning a monotonic counter.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 6: `claim.ts` part 1 — `syncJobId` and `reconcileEligibleConnections`

Spec §5.2 step 2 and §10 step 2: "the ticker's reconciliation step inserts state rows for every existing executable connection (`active` or `degraded`) that lacks them, `next_sync_at = now()` staggered over the first hour… Turning the flag on is therefore the only step; no manual seeding."

**Files:**
- Create: `apps/api/src/services/m365Sync/claim.ts`
- Create: `apps/api/src/services/m365Sync/claim.test.ts`
- Create: `apps/api/src/services/m365Sync/claim.sql.test.ts`

**Interfaces:**
- Consumes from W02: `m365SyncState`; from `db/schema`: `m365Connections`. From W03: `M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS`.
- Consumes from Task 4: `M365_SYNC_IMPLEMENTED_DOMAINS`.
- Produces (used by Tasks 7, 14, 16 and by W05's lifecycle hooks):

```ts
export function syncJobId(d: Pick<M365SyncJobData, 'orgId' | 'domain' | 'generation'>): string;
export function buildReconcileEligibleSql(now: Date): SQL;      // exported for compiled-SQL assertions
export async function reconcileEligibleConnections(now?: Date): Promise<number>;
```

- [ ] **Step 1: Write the failing tests**

`claim.sql.test.ts` — compiled SQL, imports the REAL drizzle (no `vi.mock('drizzle-orm')` anywhere in this file):

```ts
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildReconcileEligibleSql } from './claim';

/**
 * COMPILED-SQL assertions in their own file. The sibling claim.test.ts mocks the
 * db module to exercise the call shapes; its assertions substring-match and are
 * blind to the mutations that actually matter here — a dropped
 * `ON CONFLICT DO NOTHING` (every tick would raise a unique violation and the
 * whole tick would abort), a dropped status filter (revoked connections would
 * be scheduled forever), or a lost stagger (every seeded org would fire in the
 * same second the flag is turned on).
 */
describe('reconcile eligibility (compiled SQL)', () => {
  const dialect = new PgDialect();
  const NOW = new Date('2026-09-08T12:00:00.000Z');

  it('inserts one row per (executable read connection x implemented domain), doing nothing on conflict', () => {
    const { sql, params } = dialect.sqlToQuery(buildReconcileEligibleSql(NOW));
    expect(sql).toContain('insert into "m365_sync_state"');
    expect(sql).toContain('on conflict ("org_id", "domain") do nothing');
    expect(sql).toContain('from "m365_connections"');
    expect(params).toContain('customer-graph-read');
    expect(params).toContain(NOW.toISOString());
  });

  it('binds `now` as an ISO STRING cast to timestamptz, never a Date object', () => {
    const { sql, params } = dialect.sqlToQuery(buildReconcileEligibleSql(NOW));
    // postgres.js throws Buffer.byteLength at bind time on a Date in a raw
    // fragment, and compiled-SQL tests do not catch it — pin the string form.
    expect(params.some((p) => p instanceof Date)).toBe(false);
    expect(sql).toContain('::timestamptz');
  });

  it('restricts to active|degraded connections that have a verified tenant and an org', () => {
    const { sql, params } = dialect.sqlToQuery(buildReconcileEligibleSql(NOW));
    expect(params).toContain('active');
    expect(params).toContain('degraded');
    expect(sql).toContain('"tenant_id" is not null');
    expect(sql).toContain('"org_id" is not null');
  });

  it('staggers next_sync_at over the first hour rather than firing every org at once', () => {
    const { sql } = dialect.sqlToQuery(buildReconcileEligibleSql(NOW));
    expect(sql).toContain('random()');
    expect(sql).toContain('3600');
  });

  it('seeds ONLY the domains this wave can persist', () => {
    const { params } = dialect.sqlToQuery(buildReconcileEligibleSql(NOW));
    expect(params).toContain('users');
    expect(params).toContain('intune_devices');
    expect(params).toContain('ca_policies');
    expect(params).toContain('skus');
    // W05 inverts this: when M365_SYNC_IMPLEMENTED_DOMAINS becomes
    // M365_SYNC_DOMAINS these two flip to `toContain`. They are the only two
    // assertions in the wave that W05 must edit rather than extend.
    expect(params).not.toContain('signin_activity');   // W05 inverts this
    expect(params).not.toContain('secure_score');      // W05 inverts this
  });

  it('seeds each domain with its own default interval', () => {
    const { params } = dialect.sqlToQuery(buildReconcileEligibleSql(NOW));
    expect(params).toContain(6 * 3600);   // users, intune_devices
    expect(params).toContain(24 * 3600);  // ca_policies, skus
  });
});
```

`claim.test.ts` — job-id semantics plus the reconcile call shape:

```ts
import { describe, expect, it } from 'vitest';
import { syncJobId } from './claim';

describe('syncJobId', () => {
  const D = { orgId: '11111111-1111-4111-8111-111111111111', domain: 'users' as const, generation: 7 };

  it('contains NO colon — BullMQ rejects custom job ids that do', () => {
    expect(syncJobId(D)).not.toContain(':');
  });

  it('is `m365-sync-<org>-<domain>-<generation>`', () => {
    expect(syncJobId(D)).toBe('m365-sync-11111111-1111-4111-8111-111111111111-users-7');
  });

  it('changes with the generation, so a new claim is never blocked by a retained old job', () => {
    expect(syncJobId({ ...D, generation: 8 })).not.toBe(syncJobId(D));
  });

  it('is stable for the same (org, domain, generation), so a duplicate enqueue collapses', () => {
    expect(syncJobId(D)).toBe(syncJobId({ ...D }));
  });

  it('separates domains within one org', () => {
    expect(syncJobId({ ...D, domain: 'skus' })).not.toBe(syncJobId(D));
  });
});
```

- [ ] **Step 2: Run — must FAIL**

```bash
cd apps/api && npx vitest run src/services/m365Sync/claim.test.ts src/services/m365Sync/claim.sql.test.ts
```

- [ ] **Step 3: Implement** — `apps/api/src/services/m365Sync/claim.ts` (part 1; Task 7 appends to this file):

```ts
import { sql, type SQL } from 'drizzle-orm';
import { M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS } from '@breeze/shared/m365';
import { db, withSystemDbAccessContext } from '../../db';
import { M365_SYNC_IMPLEMENTED_DOMAINS, type M365SyncJobData } from './types';

const READ_PROFILE = 'customer-graph-read';
const EXECUTABLE_STATUSES = ['active', 'degraded'] as const;

/**
 * BullMQ custom job ids MUST NOT contain `:` — it is the internal key
 * separator, and a colon silently corrupts the key space. The GENERATION is in
 * the id on purpose (spec §5.2 "Priority lanes"): a retained failed job under a
 * stale generation can never block the priority-1 job a re-claim just created,
 * because they are different ids.
 */
export function syncJobId(d: Pick<M365SyncJobData, 'orgId' | 'domain' | 'generation'>): string {
  return `m365-sync-${d.orgId}-${d.domain}-${d.generation}`;
}

function rowsToExtract<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Spec §10 step 2. INSERT … SELECT over every executable customer-graph-read
 * connection crossed with the domains this wave can persist, ON CONFLICT DO
 * NOTHING on the `(org_id, domain)` unique key.
 *
 * `next_sync_at` is staggered uniformly over the first hour: without it, turning
 * the flag on would make every seeded org due in the same second and the first
 * tick would hit backpressure instead of draining.
 *
 * `now` is bound as an ISO STRING and cast, never as a Date — postgres.js
 * throws `Buffer.byteLength` at bind time on a Date inside a raw fragment, and
 * a compiled-SQL test cannot see it.
 */
export function buildReconcileEligibleSql(now: Date): SQL {
  const nowIso = now.toISOString();
  const domainRows = M365_SYNC_IMPLEMENTED_DOMAINS.map((domain) => sql`(
    ${domain}::m365_sync_domain,
    ${M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS[domain]}::int
  )`);

  return sql`
    INSERT INTO "m365_sync_state" ("org_id", "connection_id", "domain", "next_sync_at", "interval_seconds")
    SELECT
      c."org_id",
      c."id",
      d.domain,
      ${nowIso}::timestamptz + (floor(random() * 3600))::int * interval '1 second',
      d.interval_seconds
    FROM "m365_connections" c
    CROSS JOIN (VALUES ${sql.join(domainRows, sql`, `)}) AS d(domain, interval_seconds)
    WHERE c."profile" = ${READ_PROFILE}
      AND c."status" IN (${sql.join(EXECUTABLE_STATUSES.map((s) => sql`${s}`), sql`, `)})
      AND c."org_id" IS NOT NULL
      AND c."tenant_id" IS NOT NULL
    ON CONFLICT ("org_id", "domain") DO NOTHING
    RETURNING 1
  `;
}

/**
 * Runs the reconcile in its own short SYSTEM transaction. This is a cross-org
 * scheduler read (spec §8) — under a tenant context it would see nothing, and
 * contextless it would be denied outright rather than bypassing RLS.
 * Returns the number of state rows actually created.
 */
export async function reconcileEligibleConnections(now: Date = new Date()): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const result = await db.execute(buildReconcileEligibleSql(now));
    return rowsToExtract<unknown>(result).length;
  }, 'm365SyncReconcileEligible');
}
```

- [ ] **Step 4: Run — must PASS**

```bash
cd apps/api && npx vitest run src/services/m365Sync/claim.test.ts src/services/m365Sync/claim.sql.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/claim.ts apps/api/src/services/m365Sync/claim.test.ts apps/api/src/services/m365Sync/claim.sql.test.ts
git commit -m "$(cat <<'EOF'
feat(m365): add syncJobId and eligibility reconciliation

Colon-free BullMQ job ids carrying the run generation, so a retained failed
job under a stale generation can never block a fresh claim. Reconcile is an
INSERT..SELECT ON CONFLICT DO NOTHING over executable customer-graph-read
connections, staggered over the first hour so flipping the flag does not
make every org due in the same second (spec §10 step 2).

Only the four domains this wave persists are seeded; W05 widens the set when
signin_activity and secure_score get their persisters.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 7: `jobs/m365SyncQueue.ts` + `claimDueDomains` / `claimAndEnqueue`

Spec §5.2 steps 3–4, "Recovery" and "Priority lanes".

**Files:**
- Create: `apps/api/src/jobs/m365SyncQueue.ts`
- Edit: `apps/api/src/services/m365Sync/claim.ts`
- Edit: `apps/api/src/services/m365Sync/claim.test.ts`, `apps/api/src/services/m365Sync/claim.sql.test.ts`
- Create: `apps/api/src/jobs/m365SyncQueue.test.ts`

**Interfaces:**
- Produces from `jobs/m365SyncQueue.ts` (used by Tasks 13, 14 and by W05's on-demand route):

```ts
export const M365_SYNC_QUEUE = 'm365-sync';
export const M365_SYNC_TICK_JOB_ID = 'm365-sync-tick';
export const SYNC_DOMAIN_JOB_OPTS: Omit<JobsOptions, 'jobId' | 'priority'>;
export function getM365SyncQueue(): Queue<M365SyncQueueJobData>;
export async function closeM365SyncQueue(): Promise<void>;
export async function enqueueSyncDomain(data: M365SyncJobData): Promise<string>;
export function m365SyncBackoff(attemptsMade: number): number;   // 30s / 120s / 480s ladder
```
- Produces from `claim.ts`:
```ts
export function buildClaimDueDomainsSql(opts: { limit: number; now: Date; orgId?: string; domains?: M365SyncDomain[] }): SQL;
export async function claimDueDomains(opts: { limit: number; now?: Date; orgId?: string;
  domains?: M365SyncDomain[]; priority?: 1 | 10 }): Promise<M365SyncJobData[]>;
export async function claimAndEnqueue(orgId: string, domains: M365SyncDomain[], priority: 1 | 10): Promise<void>;
export async function countDueDomains(now?: Date): Promise<number>;
```

- [ ] **Step 1: Write the failing tests**

Append to `claim.sql.test.ts`:

```ts
import { buildClaimDueDomainsSql } from './claim';

describe('claimDueDomains (compiled SQL) — spec §5.2 step 3', () => {
  const dialect = new PgDialect();
  const NOW = new Date('2026-09-08T12:00:00.000Z');
  const compile = (over = {}) => dialect.sqlToQuery(buildClaimDueDomainsSql({ limit: 200, now: NOW, ...over }));

  it('locks ONLY the state row and skips rows another ticker already holds', () => {
    const { sql } = compile();
    // `OF s` matters: locking m365_connections too would serialise every domain
    // of one org behind its connection row for the whole tick.
    expect(sql).toContain('for update of s skip locked');
    expect(sql.toLowerCase()).not.toContain('for update of s, c');
  });

  it('joins the connection on BOTH id and org_id, so a claim can never cross a tenant', () => {
    const { sql } = compile();
    expect(sql).toContain('c."id" = s."connection_id"');
    expect(sql).toContain('c."org_id" = s."org_id"');
  });

  it('selects only due, unleased rows on an executable connection', () => {
    const { sql, params } = compile();
    expect(sql).toContain('s."next_sync_at" is not null');
    expect(sql).toContain('s."next_sync_at" <=');
    expect(sql).toContain('s."lease_until" is null or s."lease_until" <');
    expect(params).toContain('active');
    expect(params).toContain('degraded');
  });

  it('orders by next_sync_at and honours the batch limit', () => {
    const { sql, params } = compile({ limit: 25 });
    expect(sql).toContain('order by s."next_sync_at" asc');
    expect(params).toContain(25);
  });

  it('takes a 20-minute lease and INCREMENTS the generation', () => {
    const { sql } = compile();
    expect(sql).toContain(`interval '20 minutes'`);
    expect(sql).toContain('"run_generation" = t."run_generation" + 1');
  });

  it('does NOT touch next_sync_at — cadence advances only on completion (spec §5.2)', () => {
    const { sql } = compile();
    const update = sql.slice(sql.toLowerCase().indexOf('update "m365_sync_state"'));
    expect(update).not.toContain('"next_sync_at" =');
  });

  it('keys the UPDATE on the unique (org_id, domain), not on an unstated surrogate id', () => {
    const { sql } = compile();
    expect(sql).toContain('t."org_id" = due."org_id"');
    expect(sql).toContain('t."domain" = due."domain"');
  });

  it('returns everything the job payload needs, including the NEW generation', () => {
    const { sql } = compile();
    for (const fragment of [
      't."org_id"', 't."domain"', 't."run_generation"',
      'due."connection_id"', 'due."tenant_id"', 'due."consent_generation"',
    ]) expect(sql).toContain(fragment);
  });

  it('narrows to one org and an explicit domain list when asked (the priority-1 lane)', () => {
    const { sql, params } = compile({ orgId: 'org-1', domains: ['users', 'skus'] });
    expect(sql).toContain('s."org_id" =');
    expect(params).toContain('org-1');
    expect(params).toContain('users');
    expect(params).toContain('skus');
  });

  it('binds every timestamp as an ISO string, never a Date', () => {
    const { params } = compile();
    expect(params.some((p) => p instanceof Date)).toBe(false);
  });
});
```

Append to `claim.test.ts` (db + queue mocked):

```ts
const { dbMocks, queueMocks } = vi.hoisted(() => ({
  dbMocks: { execute: vi.fn(), systemDepth: 0 },
  queueMocks: { enqueue: vi.fn(async () => 'job-1') },
}));

vi.mock('../../db', () => ({
  db: { execute: dbMocks.execute },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    dbMocks.systemDepth += 1;
    try { return await fn(); } finally { dbMocks.systemDepth -= 1; }
  }),
}));
vi.mock('../../jobs/m365SyncQueue', () => ({ enqueueSyncDomain: queueMocks.enqueue }));

describe('claimDueDomains', () => {
  beforeEach(() => { vi.clearAllMocks(); dbMocks.systemDepth = 0; });

  it('runs inside a SYSTEM db context — a cross-org scheduler read is denied without one', async () => {
    dbMocks.execute.mockImplementation(async () => {
      expect(dbMocks.systemDepth).toBeGreaterThan(0);
      return { rows: [] };
    });
    await claimDueDomains({ limit: 10 });
    expect(dbMocks.execute).toHaveBeenCalledTimes(1);
  });

  it('maps claimed rows into fully-formed job payloads at priority 10 by default', async () => {
    dbMocks.execute.mockResolvedValue({ rows: [{
      org_id: 'org-1', domain: 'users', run_generation: 4,
      connection_id: 'conn-1', tenant_id: 'tenant-1', consent_generation: 2,
    }] });
    await expect(claimDueDomains({ limit: 10 })).resolves.toEqual([{
      orgId: 'org-1', domain: 'users', generation: 4,
      connectionId: 'conn-1', tenantId: 'tenant-1', consentGeneration: 2, priority: 10,
    }]);
  });

  it('stamps priority 1 when the caller asks for the on-demand lane', async () => {
    dbMocks.execute.mockResolvedValue({ rows: [{
      org_id: 'org-1', domain: 'skus', run_generation: 1,
      connection_id: 'conn-1', tenant_id: 'tenant-1', consent_generation: 0,
    }] });
    const [job] = await claimDueDomains({ limit: 10, priority: 1 });
    expect(job!.priority).toBe(1);
  });

  it('returns [] on an empty claim without enqueuing anything', async () => {
    dbMocks.execute.mockResolvedValue({ rows: [] });
    await expect(claimDueDomains({ limit: 10 })).resolves.toEqual([]);
    expect(queueMocks.enqueue).not.toHaveBeenCalled();
  });
});

describe('claimAndEnqueue', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('sets next_sync_at = now BEFORE claiming, then enqueues each claimed row', async () => {
    const calls: string[] = [];
    dbMocks.execute.mockImplementation(async (statement: unknown) => {
      calls.push(String((statement as { queryChunks?: unknown[] }).queryChunks ? 'sql' : 'sql'));
      return calls.length === 1
        ? { rows: [] }
        : { rows: [{ org_id: 'org-1', domain: 'users', run_generation: 3,
            connection_id: 'conn-1', tenant_id: 'tenant-1', consent_generation: 1 }] };
    });
    await claimAndEnqueue('org-1', ['users'], 1);
    expect(dbMocks.execute).toHaveBeenCalledTimes(2);   // the due-now update, then the claim
    expect(queueMocks.enqueue).toHaveBeenCalledTimes(1);
    expect(queueMocks.enqueue.mock.calls[0]![0]).toMatchObject({ orgId: 'org-1', domain: 'users', priority: 1 });
  });

  it('enqueues OUTSIDE the db context, never with a pooled connection held (#1105)', async () => {
    dbMocks.execute.mockResolvedValue({ rows: [{ org_id: 'org-1', domain: 'users', run_generation: 3,
      connection_id: 'conn-1', tenant_id: 'tenant-1', consent_generation: 1 }] });
    queueMocks.enqueue.mockImplementation(async () => {
      expect(dbMocks.systemDepth).toBe(0);
      return 'job-1';
    });
    await claimAndEnqueue('org-1', ['users'], 1);
    expect(queueMocks.enqueue).toHaveBeenCalled();
  });
});
```

`jobs/m365SyncQueue.test.ts` (new), mirroring `huntressSyncQueue.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const addMock = vi.fn(async (..._args: unknown[]) => ({ id: 'job-1' }));
const getJobMock = vi.fn(async (..._args: unknown[]) => null);

vi.mock('bullmq', () => ({
  Queue: class { add = addMock; getJob = getJobMock; close = vi.fn(); },
  Worker: class {},
  Job: class {},
  UnrecoverableError: class extends Error {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));

import { enqueueSyncDomain, m365SyncBackoff, SYNC_DOMAIN_JOB_OPTS } from './m365SyncQueue';

const JOB = {
  orgId: '11111111-1111-4111-8111-111111111111', domain: 'users' as const, generation: 3,
  connectionId: '22222222-2222-4222-8222-222222222222', tenantId: 'tenant-1',
  consentGeneration: 1, priority: 10 as const,
};

describe('m365-sync enqueue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enqueues sync-domain under the generation-scoped, colon-free job id', async () => {
    await enqueueSyncDomain(JOB);
    const [name, data, opts] = addMock.mock.calls[0]!;
    expect(name).toBe('sync-domain');
    expect(data).toMatchObject({ orgId: JOB.orgId, domain: 'users', generation: 3 });
    expect((opts as { jobId: string }).jobId).toBe('m365-sync-11111111-1111-4111-8111-111111111111-users-3');
    expect((opts as { jobId: string }).jobId).not.toContain(':');
  });

  it('carries priority, 3 attempts, custom backoff, and the retention policy from the spec', async () => {
    await enqueueSyncDomain(JOB);
    expect(addMock.mock.calls[0]![2]).toMatchObject({
      priority: 10,
      attempts: 3,
      backoff: { type: 'custom' },
      removeOnComplete: true,
      removeOnFail: { count: 100 },
    });
  });

  it('carries the priority-1 lane through unchanged', async () => {
    await enqueueSyncDomain({ ...JOB, priority: 1 });
    expect(addMock.mock.calls[0]![2]).toMatchObject({ priority: 1 });
  });

  it('replaces a STALE retained job rather than being silently discarded by BullMQ dedup', async () => {
    const remove = vi.fn(async () => undefined);
    getJobMock.mockResolvedValueOnce({ id: 'old', getState: async () => 'failed', remove } as never);
    await enqueueSyncDomain(JOB);
    expect(remove).toHaveBeenCalled();
    expect(addMock).toHaveBeenCalled();
  });

  it('reuses a genuinely in-flight job instead of restarting it underneath itself', async () => {
    getJobMock.mockResolvedValueOnce({ id: 'live', getState: async () => 'active', remove: vi.fn() } as never);
    await enqueueSyncDomain(JOB);
    expect(addMock).not.toHaveBeenCalled();
  });

  it('backoff ladder is 30s / 120s / 480s and clamps beyond the ladder', () => {
    expect(m365SyncBackoff(1)).toBe(30_000);
    expect(m365SyncBackoff(2)).toBe(120_000);
    expect(m365SyncBackoff(3)).toBe(480_000);
    expect(m365SyncBackoff(9)).toBe(480_000);
    expect(m365SyncBackoff(0)).toBe(30_000);
  });

  it('never returns -1 (a -1 would stop retries and break reportOnlyWhenExhausted)', () => {
    for (let i = -2; i < 12; i++) expect(m365SyncBackoff(i)).toBeGreaterThan(0);
  });

  it('exports job opts with no jobId or priority baked in', () => {
    expect(SYNC_DOMAIN_JOB_OPTS).not.toHaveProperty('jobId');
    expect(SYNC_DOMAIN_JOB_OPTS).not.toHaveProperty('priority');
  });
});
```

- [ ] **Step 2: Run — must FAIL**

```bash
cd apps/api && npx vitest run src/services/m365Sync/claim.test.ts src/services/m365Sync/claim.sql.test.ts src/jobs/m365SyncQueue.test.ts
```

- [ ] **Step 3: Implement**

`apps/api/src/jobs/m365SyncQueue.ts` (new leaf — see contract delta 6):

```ts
import { Queue, type JobsOptions } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { enqueueOrReplaceStale } from '../services/bullmqUtils';
import { syncJobId } from '../services/m365Sync/claim';
import type { M365SyncJobData } from '../services/m365Sync/types';

/**
 * Queue handle + enqueue policy for the m365 tenant sync, in its own leaf
 * module. `services/m365Sync/claim.ts` must enqueue (the priority-1 lane) and
 * `jobs/m365SyncWorker.ts` must claim; putting the Queue in the worker file
 * would make those two import each other.
 */
export const M365_SYNC_QUEUE = 'm365-sync';
export const M365_SYNC_TICK_JOB_ID = 'm365-sync-tick';
export const M365_SYNC_TICK_INTERVAL_MS = 60_000;

export type M365SyncQueueJobData = M365SyncJobData | Record<string, never>;

/**
 * Spec §5.2 step 4. `removeOnComplete: true` keeps Redis flat — a completed
 * run is fully described by m365_sync_state. Failures are retained (100) so an
 * operator can see why a domain stopped.
 */
export const SYNC_DOMAIN_JOB_OPTS: Omit<JobsOptions, 'jobId' | 'priority'> = {
  removeOnComplete: true,
  removeOnFail: { count: 100 },
  attempts: 3,
  backoff: { type: 'custom' },
};

/**
 * 30 s / 2 min / 8 min (spec §5.7). BullMQ passes the 1-based attempt number.
 * Never returns -1: a -1 tells BullMQ to stop retrying WITHOUT advancing
 * attemptsMade, which would strand `reportOnlyWhenExhausted` reports forever
 * (see the hazard note in jobs/workerObservability.ts).
 */
const BACKOFF_LADDER_MS = [30_000, 120_000, 480_000] as const;
export function m365SyncBackoff(attemptsMade: number): number {
  const index = Math.min(Math.max(Math.trunc(attemptsMade), 1), BACKOFF_LADDER_MS.length) - 1;
  return BACKOFF_LADDER_MS[index]!;
}

let queue: Queue<M365SyncQueueJobData> | null = null;

export function getM365SyncQueue(): Queue<M365SyncQueueJobData> {
  if (!queue) {
    queue = new Queue<M365SyncQueueJobData>(M365_SYNC_QUEUE, { connection: getBullMQConnection() });
  }
  return queue;
}

export async function closeM365SyncQueue(): Promise<void> {
  if (queue) { await queue.close(); queue = null; }
}

/**
 * A bare `queue.add({ jobId })` would be silently DISCARDED when a retained
 * FAILED job already holds the id — a permanent wedge with no error anywhere.
 * `enqueueOrReplaceStale` reuses a genuinely in-flight job and replaces a spent
 * record. The generation in the id means a fresh claim never collides with an
 * old one anyway; this is the belt to that braces.
 */
export async function enqueueSyncDomain(data: M365SyncJobData): Promise<string> {
  const { id } = await enqueueOrReplaceStale(
    getM365SyncQueue(),
    'sync-domain',
    syncJobId(data),
    data,
    { ...SYNC_DOMAIN_JOB_OPTS, priority: data.priority },
    '[M365Sync]',
  );
  return id;
}
```

Append to `apps/api/src/services/m365Sync/claim.ts`:

```ts
import type { M365SyncDomain } from '@breeze/shared/m365';
import { enqueueSyncDomain } from '../../jobs/m365SyncQueue';
import { M365_SYNC_LEASE_MINUTES } from './types';

interface ClaimedRow {
  org_id: string;
  domain: M365SyncDomain;
  run_generation: number;
  connection_id: string;
  tenant_id: string;
  consent_generation: number;
}

/**
 * Spec §5.2 step 3, as ONE statement so the select-lock and the lease/generation
 * write cannot be torn apart by a crash between them.
 *
 * Three properties this SQL is load-bearing for, each with its own compiled-SQL
 * assertion in claim.sql.test.ts:
 *
 *  - `FOR UPDATE OF s SKIP LOCKED` locks only the state row. Locking the
 *    connection too would serialise every domain of one org behind one row.
 *  - `next_sync_at` is NOT touched. Cadence advances only when a run COMPLETES,
 *    so a failed handoff or a dead worker leaves the row due and the lease
 *    expires into a fresh claim with a new generation (spec §5.2 "Recovery").
 *    Advancing it here is exactly the bug the advisor quorum found in draft v1.
 *  - The UPDATE is keyed on the unique `(org_id, domain)`, not a surrogate id,
 *    so it does not depend on a column the spec never pins.
 */
export function buildClaimDueDomainsSql(opts: {
  limit: number; now: Date; orgId?: string; domains?: M365SyncDomain[];
}): SQL {
  const nowIso = opts.now.toISOString();
  const orgFilter = opts.orgId ? sql` AND s."org_id" = ${opts.orgId}` : sql``;
  const domainFilter = opts.domains?.length
    ? sql` AND s."domain" IN (${sql.join(opts.domains.map((d) => sql`${d}::m365_sync_domain`), sql`, `)})`
    : sql``;

  return sql`
    WITH due AS (
      SELECT s."org_id", s."domain", c."id" AS connection_id, c."tenant_id", c."consent_generation"
      FROM "m365_sync_state" s
      JOIN "m365_connections" c
        ON c."id" = s."connection_id" AND c."org_id" = s."org_id"
      WHERE s."next_sync_at" IS NOT NULL
        AND s."next_sync_at" <= ${nowIso}::timestamptz
        AND (s."lease_until" IS NULL OR s."lease_until" < ${nowIso}::timestamptz)
        AND c."status" IN (${sql.join(EXECUTABLE_STATUSES.map((s2) => sql`${s2}`), sql`, `)})
        AND c."tenant_id" IS NOT NULL${orgFilter}${domainFilter}
      ORDER BY s."next_sync_at" ASC
      LIMIT ${opts.limit}
      FOR UPDATE OF s SKIP LOCKED
    )
    UPDATE "m365_sync_state" AS t
    SET "lease_until" = ${nowIso}::timestamptz + interval '${sql.raw(String(M365_SYNC_LEASE_MINUTES))} minutes',
        "run_generation" = t."run_generation" + 1,
        "updated_at" = ${nowIso}::timestamptz
    FROM due
    WHERE t."org_id" = due."org_id" AND t."domain" = due."domain"
    RETURNING t."org_id", t."domain", t."run_generation",
              due."connection_id", due."tenant_id", due."consent_generation"
  `;
}

export async function claimDueDomains(opts: {
  limit: number; now?: Date; orgId?: string; domains?: M365SyncDomain[]; priority?: 1 | 10;
}): Promise<M365SyncJobData[]> {
  const now = opts.now ?? new Date();
  const priority = opts.priority ?? 10;
  const rows = await withSystemDbAccessContext(async () => {
    const result = await db.execute(buildClaimDueDomainsSql({
      limit: opts.limit, now, orgId: opts.orgId, domains: opts.domains,
    }));
    return rowsToExtract<ClaimedRow>(result);
  }, 'm365SyncClaimDue');

  return rows.map((row) => ({
    orgId: row.org_id,
    domain: row.domain,
    generation: Number(row.run_generation),
    connectionId: row.connection_id,
    tenantId: row.tenant_id,
    consentGeneration: Number(row.consent_generation),
    priority,
  }));
}

/** Gauge feed for `m365_sync_due_backlog` (spec §5.9). Uses the partial index on next_sync_at. */
export async function countDueDomains(now: Date = new Date()): Promise<number> {
  const nowIso = now.toISOString();
  return withSystemDbAccessContext(async () => {
    const result = await db.execute(sql`
      SELECT count(*)::int AS due
      FROM "m365_sync_state"
      WHERE "next_sync_at" IS NOT NULL AND "next_sync_at" <= ${nowIso}::timestamptz
    `);
    return Number(rowsToExtract<{ due: number }>(result)[0]?.due ?? 0);
  }, 'm365SyncCountDue');
}

/**
 * The priority lane (spec §5.2): make the named domains due NOW, then run the
 * SAME claim so they get a generation and a lease like any other run — an
 * on-demand run that skipped the claim would have no fence at Phase C.
 *
 * The enqueue happens AFTER the claim's transaction has committed. Issuing
 * Redis commands with a pooled connection held open is the #1105 anti-pattern,
 * and a job that started before its own claim committed could read a stale
 * generation and fence itself.
 */
export async function claimAndEnqueue(
  orgId: string,
  domains: M365SyncDomain[],
  priority: 1 | 10,
): Promise<void> {
  if (domains.length === 0) return;
  const now = new Date();
  const nowIso = now.toISOString();

  await withSystemDbAccessContext(async () => {
    await db.execute(sql`
      UPDATE "m365_sync_state"
      SET "next_sync_at" = ${nowIso}::timestamptz, "updated_at" = ${nowIso}::timestamptz
      WHERE "org_id" = ${orgId}
        AND "domain" IN (${sql.join(domains.map((d) => sql`${d}::m365_sync_domain`), sql`, `)})
    `);
  }, 'm365SyncMakeDue');

  const claimed = await claimDueDomains({ limit: domains.length, now, orgId, domains, priority });
  for (const job of claimed) await enqueueSyncDomain(job);
}
```

- [ ] **Step 4: Run — must PASS**

```bash
cd apps/api && npx vitest run src/services/m365Sync/claim.test.ts src/services/m365Sync/claim.sql.test.ts src/jobs/m365SyncQueue.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/m365SyncQueue.ts apps/api/src/jobs/m365SyncQueue.test.ts apps/api/src/services/m365Sync/claim.ts apps/api/src/services/m365Sync/claim.test.ts apps/api/src/services/m365Sync/claim.sql.test.ts
git commit -m "$(cat <<'EOF'
feat(m365): add the claim/lease/generation protocol and the sync queue

One statement takes FOR UPDATE OF s SKIP LOCKED on the state row, bumps
run_generation and sets a 20-minute lease — and deliberately does NOT touch
next_sync_at, so a failed handoff or a dead worker leaves the row due and the
lease expires into a fresh claim (spec §5.2 "Recovery").

claimAndEnqueue reuses the same statement for the priority-1 lane and
enqueues only after the claim transaction has committed. The Queue lives in
its own leaf module so claim.ts and m365SyncWorker.ts do not import each
other.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 8: `domains/persist.ts` (shared partition/chunk helper) + `domains/users.ts`

Spec §5.3 Phase C, §5.4 (change-only writes), §5.9 (in-memory counts). **Primary fields only in this wave** — the enrichment columns (`mfa_registered`, `mfa_capable`, `default_mfa_method`, `admin_roles`, `is_admin`, `last_successful_sign_in_at`) are W05's and must be left untouched by both the INSERT and the conflict SET.

**Files:**
- Create: `apps/api/src/services/m365Sync/domains/persist.ts`
- Create: `apps/api/src/services/m365Sync/domains/persist.test.ts`
- Create: `apps/api/src/services/m365Sync/domains/users.ts`
- Create: `apps/api/src/services/m365Sync/domains/users.test.ts`

**Interfaces:**
- Consumes from W02: `m365Users`. From Task 4: `PersistContext`, `DomainPersistResult`, `M365_SYNC_PERSIST_CHUNK_SIZE`, `canonicalHash`.
- Produces:

```ts
// persist.ts
export interface EntityPlan<TRow> { rows: TRow[]; inserted: number; updated: number; unchanged: number; staleIds: string[] }
export function planEntityWrites<TItem, TRow>(ctx: PersistContext, items: TItem[], complete: boolean, build: (item: TItem) => { graphId: string; coreHash: string; row: TRow } | null): EntityPlan<TRow>;
export async function writeEntityChunks<TRow>(rows: TRow[], write: (chunk: TRow[]) => Promise<void>): Promise<void>;
export async function markEntitiesStale(table: AnyPgTable, orgId: string, graphIds: string[], now: Date): Promise<number>;
// users.ts
export async function persistUsers(ctx: PersistContext, result: M365SyncActionResult): Promise<DomainPersistResult>;
/**
 * EXPORTED, not module-private: it is the definition of "primary user fields"
 * and `core_hash`'s input. W05's enrichment persister must hash exactly the
 * same projection or every user row would be rewritten on the first enrichment
 * run, so it imports this rather than re-deriving the field list.
 */
export function usersPrimaryProjection(item: Record<string, unknown>): Record<string, unknown>;
```

- [ ] **Step 1: Write the failing tests**

`domains/persist.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { planEntityWrites, writeEntityChunks } from './persist';

const ctx = (existing: Array<[string, { coreHash: string; isStale: boolean }]>) => ({
  orgId: 'org-1', tenantId: 't', connectionId: 'c', generation: 1,
  existing: new Map(existing), now: new Date('2026-09-08T00:00:00.000Z'),
});
const build = (item: { id: string; hash: string }) => ({ graphId: item.id, coreHash: item.hash, row: item });

describe('planEntityWrites (spec §5.4)', () => {
  it('writes NOTHING when every fetched row hashes identically to its stored row', () => {
    const plan = planEntityWrites(ctx([['a', { coreHash: 'h1', isStale: false }]]),
      [{ id: 'a', hash: 'h1' }], true, build);
    expect(plan.rows).toEqual([]);
    expect(plan.unchanged).toBe(1);
    expect(plan.inserted).toBe(0);
    expect(plan.updated).toBe(0);
  });

  it('counts an unknown graph id as an insert and a differing hash as an update', () => {
    const plan = planEntityWrites(ctx([['a', { coreHash: 'h1', isStale: false }]]),
      [{ id: 'a', hash: 'h2' }, { id: 'b', hash: 'h9' }], true, build);
    expect(plan.inserted).toBe(1);
    expect(plan.updated).toBe(1);
    expect(plan.rows).toHaveLength(2);
  });

  it('REWRITES an unchanged row that is currently stale, so a returning object is un-tombstoned', () => {
    const plan = planEntityWrites(ctx([['a', { coreHash: 'h1', isStale: true }]]),
      [{ id: 'a', hash: 'h1' }], true, build);
    expect(plan.updated).toBe(1);
    expect(plan.rows).toHaveLength(1);
    expect(plan.unchanged).toBe(0);
  });

  it('marks vanished rows stale ONLY on a complete run', () => {
    const stored: Array<[string, { coreHash: string; isStale: boolean }]> = [
      ['a', { coreHash: 'h1', isStale: false }], ['gone', { coreHash: 'h2', isStale: false }],
    ];
    expect(planEntityWrites(ctx(stored), [{ id: 'a', hash: 'h1' }], true, build).staleIds).toEqual(['gone']);
    expect(planEntityWrites(ctx(stored), [{ id: 'a', hash: 'h1' }], false, build).staleIds).toEqual([]);
  });

  it('never re-marks an already-stale row, so stale_since is not rewritten every run', () => {
    const plan = planEntityWrites(ctx([['gone', { coreHash: 'h2', isStale: true }]]), [], true, build);
    expect(plan.staleIds).toEqual([]);
  });

  it('drops an item the builder cannot project (missing graph id) rather than writing a null key', () => {
    const plan = planEntityWrites(ctx([]), [{ id: '', hash: 'h' }], true,
      (item) => (item.id ? build(item) : null));
    expect(plan.rows).toEqual([]);
    expect(plan.inserted).toBe(0);
  });

  it('de-duplicates a graph id repeated in one response, last write wins', () => {
    const plan = planEntityWrites(ctx([]), [{ id: 'a', hash: 'h1' }, { id: 'a', hash: 'h2' }], true, build);
    expect(plan.rows).toHaveLength(1);
    expect(plan.inserted).toBe(1);
  });
});

describe('writeEntityChunks', () => {
  it('splits at 1000 and issues ONE call per chunk (spec §5.3)', async () => {
    const sizes: number[] = [];
    await writeEntityChunks(Array.from({ length: 2500 }, (_, i) => i), async (c) => { sizes.push(c.length); });
    expect(sizes).toEqual([1000, 1000, 500]);
  });

  it('issues no call at all for an empty plan', async () => {
    const write = vi.fn();
    await writeEntityChunks([], write);
    expect(write).not.toHaveBeenCalled();
  });
});
```

`domains/users.test.ts` (db mocked; assert on the values/set payloads):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMocks } = vi.hoisted(() => ({
  dbMocks: { inserted: [] as unknown[], setPayloads: [] as Record<string, unknown>[], updates: [] as unknown[] },
}));

vi.mock('../../../db', () => ({
  db: {
    insert: () => ({
      values: (rows: unknown[]) => {
        dbMocks.inserted.push(...rows);
        return { onConflictDoUpdate: (cfg: { set: Record<string, unknown> }) => {
          dbMocks.setPayloads.push(cfg.set);
          return Promise.resolve();
        } };
      },
    }),
    update: () => ({ set: () => ({ where: () => { dbMocks.updates.push(true); return Promise.resolve(); } }) }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

import { persistUsers } from './users';

const ctx = (existing: Array<[string, { coreHash: string; isStale: boolean }]> = []) => ({
  orgId: 'org-1', tenantId: 'tenant-1', connectionId: 'conn-1', generation: 2,
  existing: new Map(existing), now: new Date('2026-09-08T00:00:00.000Z'),
});
const user = (over = {}) => ({
  id: 'u1', userPrincipalName: 'a@x.test', displayName: 'A', mail: 'a@x.test',
  accountEnabled: true, jobTitle: null, department: null, usageLocation: 'GB',
  onPremisesSyncEnabled: false, createdDateTime: '2020-01-01T00:00:00Z',
  assignedLicenses: ['sku-1'], mfaRegistered: true, mfaCapable: true,
  defaultMfaMethod: 'app', adminRoles: [{ roleTemplateId: 'r1', displayName: 'GA' }],
  ...over,
});
const okResult = (items: unknown[], over = {}) => ({
  success: true as const, kind: 'sync' as const, items: items as Record<string, unknown>[],
  truncated: false, fetchedAt: '2026-09-08T00:00:00.000Z',
  sources: { users: 'ok' as const, mfaRegistration: 'ok' as const, roleAssignments: 'ok' as const },
  ...over,
});

describe('persistUsers', () => {
  beforeEach(() => { vi.clearAllMocks(); dbMocks.inserted = []; dbMocks.setPayloads = []; dbMocks.updates = []; });

  it('does NOT write the W05 enrichment columns, on insert or on conflict', async () => {
    await persistUsers(ctx(), okResult([user()]));
    const forbidden = ['mfaRegistered', 'mfaCapable', 'defaultMfaMethod', 'adminRoles', 'isAdmin', 'lastSuccessfulSignInAt'];
    for (const key of forbidden) {
      expect(dbMocks.inserted[0]).not.toHaveProperty(key);
      expect(dbMocks.setPayloads[0]).not.toHaveProperty(key);
    }
  });

  it('projects the primary columns and stamps first_seen_at only on insert', async () => {
    await persistUsers(ctx(), okResult([user()]));
    expect(dbMocks.inserted[0]).toMatchObject({
      orgId: 'org-1', graphId: 'u1', userPrincipalName: 'a@x.test', displayName: 'A',
      accountEnabled: true, usageLocation: 'GB', onPremisesSyncEnabled: false,
      assignedSkuIds: ['sku-1'], isStale: false,
    });
    expect(dbMocks.inserted[0]).toHaveProperty('firstSeenAt');
    expect(dbMocks.setPayloads[0]).not.toHaveProperty('firstSeenAt');
  });

  it('un-tombstones on conflict: is_stale back to false and stale_since cleared', async () => {
    await persistUsers(ctx(), okResult([user()]));
    expect(dbMocks.setPayloads[0]).toHaveProperty('isStale');
    expect(dbMocks.setPayloads[0]).toHaveProperty('staleSince');
  });

  it('writes ZERO rows on a second identical run (change-only writes, spec §5.4)', async () => {
    const first = await persistUsers(ctx(), okResult([user()]));
    const hash = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = []; dbMocks.setPayloads = [];
    const second = await persistUsers(ctx([['u1', { coreHash: hash, isStale: false }]]), okResult([user()]));
    expect(dbMocks.inserted).toEqual([]);
    expect(second.unchanged).toBe(1);
    expect(second.inserted + second.updated).toBe(0);
    expect(first.inserted).toBe(1);
  });

  it('the hash covers PRIMARY fields only, so enrichment churn is not a change', async () => {
    await persistUsers(ctx(), okResult([user()]));
    const hashA = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = [];
    await persistUsers(ctx(), okResult([user({ mfaRegistered: false, adminRoles: [] })]));
    expect((dbMocks.inserted[0] as { coreHash: string }).coreHash).toBe(hashA);
  });

  it('a primary-field change DOES move the hash', async () => {
    await persistUsers(ctx(), okResult([user()]));
    const hashA = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = [];
    await persistUsers(ctx(), okResult([user({ accountEnabled: false })]));
    expect((dbMocks.inserted[0] as { coreHash: string }).coreHash).not.toBe(hashA);
  });

  it('counts users_total and users_enabled in memory (spec §5.9)', async () => {
    const out = await persistUsers(ctx(), okResult([user(), user({ id: 'u2', accountEnabled: false })]));
    expect(out.counts).toEqual({ users_total: 2, users_enabled: 1 });
  });

  it('is complete only when the users source is ok AND the result is not truncated', async () => {
    expect((await persistUsers(ctx(), okResult([user()]))).complete).toBe(true);
    expect((await persistUsers(ctx(), okResult([user()], { truncated: true }))).complete).toBe(false);
    expect((await persistUsers(ctx(), okResult([user()], { sources: { users: 'error' } }))).complete).toBe(false);
  });

  it('does not mark stale on a truncated run, even though a row vanished', async () => {
    const out = await persistUsers(
      ctx([['gone', { coreHash: 'h', isStale: false }]]),
      okResult([user()], { truncated: true }),
    );
    expect(out.stale).toBe(0);
    expect(dbMocks.updates).toEqual([]);
  });

  it('marks a vanished row stale on a complete run', async () => {
    const out = await persistUsers(ctx([['gone', { coreHash: 'h', isStale: false }]]), okResult([user()]));
    expect(out.stale).toBe(1);
    expect(dbMocks.updates).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run — must FAIL**

```bash
cd apps/api && npx vitest run src/services/m365Sync/domains
```

- [ ] **Step 3: Implement**

`apps/api/src/services/m365Sync/domains/persist.ts`:

```ts
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AnyPgTable } from 'drizzle-orm/pg-core';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { M365_SYNC_PERSIST_CHUNK_SIZE, type PersistContext } from '../types';

export interface EntityPlan<TRow> {
  rows: TRow[];
  inserted: number;
  updated: number;
  unchanged: number;
  staleIds: string[];
}

/**
 * The change-only-write partition (spec §5.4). Everything about which rows get
 * touched is decided HERE, in memory, before a single statement is issued —
 * which is what makes "second identical run issues zero entity writes" a
 * property of the code rather than a hope about Postgres.
 *
 * A row that is unchanged but currently STALE is rewritten, because it has
 * come back and its tombstone must be lifted; that is why `isStale` is carried
 * in the existing map at all.
 */
export function planEntityWrites<TItem, TRow>(
  ctx: PersistContext,
  items: TItem[],
  complete: boolean,
  build: (item: TItem) => { graphId: string; coreHash: string; row: TRow } | null,
): EntityPlan<TRow> {
  const byGraphId = new Map<string, { coreHash: string; row: TRow }>();
  for (const item of items) {
    const built = build(item);
    if (!built || !built.graphId) continue;
    byGraphId.set(built.graphId, { coreHash: built.coreHash, row: built.row });
  }

  const rows: TRow[] = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const [graphId, built] of byGraphId) {
    const prior = ctx.existing.get(graphId);
    if (!prior) { inserted += 1; rows.push(built.row); continue; }
    if (prior.coreHash !== built.coreHash || prior.isStale) { updated += 1; rows.push(built.row); continue; }
    unchanged += 1;
  }

  // Only a COMPLETE run may tombstone: a truncated or primary-failed run has no
  // authority to say a row is gone, it only knows it did not see it.
  const staleIds: string[] = [];
  if (complete) {
    for (const [graphId, prior] of ctx.existing) {
      if (prior.isStale) continue;
      if (!byGraphId.has(graphId)) staleIds.push(graphId);
    }
  }

  return { rows, inserted, updated, unchanged, staleIds };
}

/**
 * One SHORT transaction per 1 000-row chunk (spec §5.3). The upserts are
 * idempotent, so a failure part-way leaves a consistent partial state that the
 * next run finishes — the alternative, one transaction over 25 000 rows, would
 * hold a pooled connection for the whole write on a 1-vCPU managed database.
 */
export async function writeEntityChunks<TRow>(
  rows: TRow[],
  write: (chunk: TRow[]) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += M365_SYNC_PERSIST_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + M365_SYNC_PERSIST_CHUNK_SIZE);
    await runOutsideDbContext(() => withSystemDbAccessContext(
      () => write(chunk),
      'm365SyncPersistChunk',
    ));
  }
}

/** Set-based tombstone in one statement per chunk of ids. */
export async function markEntitiesStale(
  table: AnyPgTable & { orgId: never; graphId: never; isStale: never; staleSince: never },
  orgId: string,
  graphIds: string[],
  now: Date,
): Promise<number> {
  let marked = 0;
  for (let i = 0; i < graphIds.length; i += M365_SYNC_PERSIST_CHUNK_SIZE) {
    const chunk = graphIds.slice(i, i + M365_SYNC_PERSIST_CHUNK_SIZE);
    await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      await db.update(table)
        .set({ isStale: true, staleSince: now } as never)
        .where(and(
          eq((table as never as { orgId: never }).orgId, orgId as never),
          inArray((table as never as { graphId: never }).graphId, chunk as never),
          eq((table as never as { isStale: never }).isStale, false as never),
        ));
    }, 'm365SyncMarkStale'));
    marked += chunk.length;
  }
  return marked;
}

export { and, eq, inArray, sql };
```

`apps/api/src/services/m365Sync/domains/users.ts`:

```ts
import { db } from '../../../db';
import { m365Users } from '../../../db/schema';
import { canonicalHash } from '../hash';
import {
  M365_SYNC_PRIMARY_SOURCE_KEY,
  type DomainPersistResult, type M365SyncActionResult, type PersistContext,
} from '../types';
import { markEntitiesStale, planEntityWrites, writeEntityChunks } from './persist';

/**
 * PRIMARY fields only (spec §3.2, §5.4). The enrichment columns
 * (mfa_*, admin_roles, is_admin, last_successful_sign_in_at) are W05's and are
 * absent from BOTH the insert values and the conflict SET, so a users run can
 * never clobber enrichment written by a later, independent source. That is also
 * why they are absent from the hash: if they were in it, a registration-report
 * outage would rewrite every user row on the next run.
 */
interface UserItem {
  id?: string;
  userPrincipalName?: string | null;
  displayName?: string | null;
  mail?: string | null;
  accountEnabled?: boolean | null;
  jobTitle?: string | null;
  department?: string | null;
  usageLocation?: string | null;
  onPremisesSyncEnabled?: boolean | null;
  createdDateTime?: string | null;
  assignedLicenses?: string[] | null;
}

/**
 * The canonical primary-field projection. Exported so W05's enrichment pass
 * hashes the identical field set — a second definition would drift and rewrite
 * every user row.
 */
export function usersPrimaryProjection(item: UserItem): Record<string, unknown> {
  return {
    userPrincipalName: item.userPrincipalName ?? null,
    displayName: item.displayName ?? null,
    mail: item.mail ?? null,
    accountEnabled: item.accountEnabled ?? null,
    jobTitle: item.jobTitle ?? null,
    department: item.department ?? null,
    usageLocation: item.usageLocation ?? null,
    onPremisesSyncEnabled: item.onPremisesSyncEnabled ?? null,
    createdDateTime: item.createdDateTime ?? null,
    assignedLicenses: item.assignedLicenses ?? [],
  };
}

export async function persistUsers(
  ctx: PersistContext,
  result: M365SyncActionResult,
): Promise<DomainPersistResult> {
  const items = result.items as UserItem[];
  const primaryOk = result.sources[M365_SYNC_PRIMARY_SOURCE_KEY.users] === 'ok';
  const complete = primaryOk && !result.truncated;

  const plan = planEntityWrites(ctx, items, complete, (item) => {
    if (!item.id) return null;
    const projection = usersPrimaryProjection(item);
    return {
      graphId: item.id,
      coreHash: canonicalHash(projection),
      row: {
        orgId: ctx.orgId,
        graphId: item.id,
        userPrincipalName: projection.userPrincipalName as string | null,
        displayName: projection.displayName as string | null,
        mail: projection.mail as string | null,
        accountEnabled: projection.accountEnabled as boolean | null,
        jobTitle: projection.jobTitle as string | null,
        department: projection.department as string | null,
        usageLocation: projection.usageLocation as string | null,
        onPremisesSyncEnabled: projection.onPremisesSyncEnabled as boolean | null,
        graphCreatedAt: projection.createdDateTime ? new Date(projection.createdDateTime as string) : null,
        assignedSkuIds: projection.assignedLicenses as string[],
        coreHash: canonicalHash(projection),
        firstSeenAt: ctx.now,
        lastChangedAt: ctx.now,
        isStale: false,
        staleSince: null,
      },
    };
  });

  await writeEntityChunks(plan.rows, async (chunk) => {
    await db.insert(m365Users).values(chunk).onConflictDoUpdate({
      target: [m365Users.orgId, m365Users.graphId],
      set: {
        userPrincipalName: sqlExcluded('user_principal_name'),
        displayName: sqlExcluded('display_name'),
        mail: sqlExcluded('mail'),
        accountEnabled: sqlExcluded('account_enabled'),
        jobTitle: sqlExcluded('job_title'),
        department: sqlExcluded('department'),
        usageLocation: sqlExcluded('usage_location'),
        onPremisesSyncEnabled: sqlExcluded('on_premises_sync_enabled'),
        graphCreatedAt: sqlExcluded('graph_created_at'),
        assignedSkuIds: sqlExcluded('assigned_sku_ids'),
        coreHash: sqlExcluded('core_hash'),
        lastChangedAt: sqlExcluded('last_changed_at'),
        isStale: sqlFalse(),
        staleSince: sqlNull(),
      },
    });
  });

  const stale = plan.staleIds.length
    ? await markEntitiesStale(m365Users as never, ctx.orgId, plan.staleIds, ctx.now)
    : 0;

  return {
    inserted: plan.inserted,
    updated: plan.updated,
    unchanged: plan.unchanged,
    stale,
    complete,
    counts: {
      users_total: items.length,
      users_enabled: items.filter((item) => item.accountEnabled === true).length,
    },
  };
}
```

Add these three one-liners to `domains/persist.ts` and import them in every domain module — they keep the conflict SET readable and stop `excluded.` column names being retyped four times:

```ts
export const sqlExcluded = (column: string) => sql.raw(`excluded."${column}"`);
export const sqlFalse = () => sql`false`;
export const sqlNull = () => sql`null`;
```

> `sql.raw` is safe here and only here: the argument is a compile-time literal from this file, never operator or Graph input.

- [ ] **Step 4: Run — must PASS**

```bash
cd apps/api && npx vitest run src/services/m365Sync/domains
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/domains
git commit -m "$(cat <<'EOF'
feat(m365): add the change-only write planner and the users persister

planEntityWrites decides insert/update/unchanged/stale in memory before any
statement is issued, so "a second identical run writes zero entity rows" is a
property of the code (spec §5.4). Only a complete run tombstones; an
unchanged-but-stale row is rewritten so a returning object is un-tombstoned.

The users persister writes PRIMARY fields only — the W05 enrichment columns
are absent from the insert values, the conflict SET and the hash, so a
registration-report outage can neither clobber them nor rewrite every row.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 9: `domains/intuneDevices.ts`

Spec §3.2 (`m365_intune_devices`), §5.9 (compliance counts). **No link reconciliation in this wave** — `breeze_device_id` is never written here; W05 owns `links.ts` and the set-based pass (spec §5.6). `last_intune_sync_at` IS part of the hash by design: these rows churn every run, bounded by device count.

**Files:**
- Create: `apps/api/src/services/m365Sync/domains/intuneDevices.ts`
- Create: `apps/api/src/services/m365Sync/domains/intuneDevices.test.ts`

**Interfaces:**
- Consumes from W02: `m365IntuneDevices`. From Task 8: `planEntityWrites`, `writeEntityChunks`, `markEntitiesStale`, `sqlExcluded`/`sqlFalse`/`sqlNull`.
- Produces: `export async function persistIntuneDevices(ctx: PersistContext, result: M365SyncActionResult): Promise<DomainPersistResult>` and `export const INTUNE_COMPLIANCE_BUCKET: Record<string, keyof typeof BUCKETS>`.

- [ ] **Step 1: Write the failing test** — `domains/intuneDevices.test.ts` (reuse the `vi.mock('../../../db', …)` preamble from `users.test.ts` verbatim):

```ts
import { persistIntuneDevices } from './intuneDevices';

const device = (over = {}) => ({
  id: 'd1', deviceName: 'LAPTOP-1', operatingSystem: 'Windows', osVersion: '10.0.22631',
  complianceState: 'compliant', lastSyncDateTime: '2026-09-08T00:00:00Z',
  userPrincipalName: 'a@x.test', managedDeviceOwnerType: 'company',
  enrolledDateTime: '2025-01-01T00:00:00Z', model: 'X1', manufacturer: 'Lenovo',
  serialNumber: 'SN-1', azureADDeviceId: 'aad-1', managementAgent: 'mdm', jailBroken: 'False',
  ...over,
});
const okResult = (items: unknown[], over = {}) => ({
  success: true as const, kind: 'sync' as const, items: items as Record<string, unknown>[],
  truncated: false, fetchedAt: '2026-09-08T00:00:00.000Z',
  sources: { managedDevices: 'ok' as const }, ...over,
});

describe('persistIntuneDevices', () => {
  beforeEach(() => { vi.clearAllMocks(); dbMocks.inserted = []; dbMocks.setPayloads = []; dbMocks.updates = []; });

  it('NEVER writes breeze_device_id — link reconciliation is W05 (spec §5.6)', async () => {
    await persistIntuneDevices(ctx(), okResult([device()]));
    expect(dbMocks.inserted[0]).not.toHaveProperty('breezeDeviceId');
    expect(dbMocks.setPayloads[0]).not.toHaveProperty('breezeDeviceId');
  });

  it('projects every Graph field the table carries', async () => {
    await persistIntuneDevices(ctx(), okResult([device()]));
    expect(dbMocks.inserted[0]).toMatchObject({
      orgId: 'org-1', graphId: 'd1', deviceName: 'LAPTOP-1', operatingSystem: 'Windows',
      osVersion: '10.0.22631', complianceState: 'compliant', userPrincipalName: 'a@x.test',
      ownerType: 'company', model: 'X1', manufacturer: 'Lenovo', serialNumber: 'SN-1',
      azureAdDeviceId: 'aad-1', managementAgent: 'mdm', jailBroken: 'False',
    });
  });

  it('includes lastSyncDateTime in the hash — these rows churn by design', async () => {
    await persistIntuneDevices(ctx(), okResult([device()]));
    const a = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = [];
    await persistIntuneDevices(ctx(), okResult([device({ lastSyncDateTime: '2026-09-09T00:00:00Z' })]));
    expect((dbMocks.inserted[0] as { coreHash: string }).coreHash).not.toBe(a);
  });

  it('buckets compliance states into the five rollup counters', async () => {
    const out = await persistIntuneDevices(ctx(), okResult([
      device({ id: 'a', complianceState: 'compliant' }),
      device({ id: 'b', complianceState: 'noncompliant' }),
      device({ id: 'c', complianceState: 'conflict' }),
      device({ id: 'd', complianceState: 'error' }),
      device({ id: 'e', complianceState: 'inGracePeriod' }),
      device({ id: 'f', complianceState: 'unknown' }),
      device({ id: 'g', complianceState: 'configManager' }),
      device({ id: 'h', complianceState: null }),
    ]));
    expect(out.counts).toEqual({
      devices_total: 8, devices_compliant: 1, devices_noncompliant: 3,
      devices_in_grace: 1, devices_unknown: 3,
    });
  });

  it('is case-insensitive about the compliance state Graph returns', async () => {
    const out = await persistIntuneDevices(ctx(), okResult([device({ complianceState: 'Compliant' })]));
    expect(out.counts.devices_compliant).toBe(1);
  });

  it('stores the raw Graph compliance string, not the bucket', async () => {
    await persistIntuneDevices(ctx(), okResult([device({ complianceState: 'inGracePeriod' })]));
    expect(dbMocks.inserted[0]).toMatchObject({ complianceState: 'inGracePeriod' });
  });

  it('writes nothing on an identical second run', async () => {
    await persistIntuneDevices(ctx(), okResult([device()]));
    const hash = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = [];
    const out = await persistIntuneDevices(ctx([['d1', { coreHash: hash, isStale: false }]]), okResult([device()]));
    expect(dbMocks.inserted).toEqual([]);
    expect(out.unchanged).toBe(1);
  });

  it('does not mark stale when managedDevices did not return ok', async () => {
    const out = await persistIntuneDevices(
      ctx([['gone', { coreHash: 'h', isStale: false }]]),
      okResult([device()], { sources: { managedDevices: 'permission_missing' } }),
    );
    expect(out.complete).toBe(false);
    expect(out.stale).toBe(0);
  });
});
```

- [ ] **Step 2: Run — must FAIL**

```bash
cd apps/api && npx vitest run src/services/m365Sync/domains/intuneDevices.test.ts
```

- [ ] **Step 3: Implement** — `apps/api/src/services/m365Sync/domains/intuneDevices.ts`:

```ts
import { db } from '../../../db';
import { m365IntuneDevices } from '../../../db/schema';
import { canonicalHash } from '../hash';
import {
  M365_SYNC_PRIMARY_SOURCE_KEY,
  type DomainPersistResult, type M365SyncActionResult, type PersistContext,
} from '../types';
import {
  markEntitiesStale, planEntityWrites, sqlExcluded, sqlFalse, sqlNull, writeEntityChunks,
} from './persist';

interface DeviceItem {
  id?: string;
  deviceName?: string | null;
  operatingSystem?: string | null;
  osVersion?: string | null;
  complianceState?: string | null;
  lastSyncDateTime?: string | null;
  userPrincipalName?: string | null;
  managedDeviceOwnerType?: string | null;
  enrolledDateTime?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  serialNumber?: string | null;
  azureADDeviceId?: string | null;
  managementAgent?: string | null;
  jailBroken?: string | null;
}

type ComplianceBucket = 'devices_compliant' | 'devices_noncompliant' | 'devices_in_grace' | 'devices_unknown';

/**
 * Graph's `complianceState` is an open string that passes through to the column
 * untouched (spec §3.2). Only the ROLLUP counters bucket it, and the bucketing
 * is explicit rather than "anything not compliant is noncompliant": `unknown`
 * and `configManager` are genuinely not a compliance verdict, and reporting
 * them as non-compliant would invent a security finding.
 */
const COMPLIANCE_BUCKETS: Record<string, ComplianceBucket> = {
  compliant: 'devices_compliant',
  noncompliant: 'devices_noncompliant',
  conflict: 'devices_noncompliant',
  error: 'devices_noncompliant',
  ingraceperiod: 'devices_in_grace',
  unknown: 'devices_unknown',
  configmanager: 'devices_unknown',
};

export function complianceBucket(state: string | null | undefined): ComplianceBucket {
  if (!state) return 'devices_unknown';
  return COMPLIANCE_BUCKETS[state.trim().toLowerCase()] ?? 'devices_unknown';
}

function projection(item: DeviceItem): Record<string, unknown> {
  return {
    deviceName: item.deviceName ?? null,
    operatingSystem: item.operatingSystem ?? null,
    osVersion: item.osVersion ?? null,
    complianceState: item.complianceState ?? null,
    // In the hash on purpose: an Intune device's last check-in is the single
    // most useful freshness fact on the row, and these rows are bounded by
    // device count, so the churn is affordable (spec §3.2).
    lastSyncDateTime: item.lastSyncDateTime ?? null,
    userPrincipalName: item.userPrincipalName ?? null,
    managedDeviceOwnerType: item.managedDeviceOwnerType ?? null,
    enrolledDateTime: item.enrolledDateTime ?? null,
    model: item.model ?? null,
    manufacturer: item.manufacturer ?? null,
    serialNumber: item.serialNumber ?? null,
    azureADDeviceId: item.azureADDeviceId ?? null,
    managementAgent: item.managementAgent ?? null,
    jailBroken: item.jailBroken ?? null,
  };
}

export async function persistIntuneDevices(
  ctx: PersistContext,
  result: M365SyncActionResult,
): Promise<DomainPersistResult> {
  const items = result.items as DeviceItem[];
  const primaryOk = result.sources[M365_SYNC_PRIMARY_SOURCE_KEY.intune_devices] === 'ok';
  const complete = primaryOk && !result.truncated;

  const plan = planEntityWrites(ctx, items, complete, (item) => {
    if (!item.id) return null;
    const p = projection(item);
    return {
      graphId: item.id,
      coreHash: canonicalHash(p),
      row: {
        orgId: ctx.orgId,
        graphId: item.id,
        deviceName: p.deviceName as string | null,
        operatingSystem: p.operatingSystem as string | null,
        osVersion: p.osVersion as string | null,
        complianceState: p.complianceState as string | null,
        lastIntuneSyncAt: p.lastSyncDateTime ? new Date(p.lastSyncDateTime as string) : null,
        userPrincipalName: p.userPrincipalName as string | null,
        ownerType: p.managedDeviceOwnerType as string | null,
        enrolledAt: p.enrolledDateTime ? new Date(p.enrolledDateTime as string) : null,
        model: p.model as string | null,
        manufacturer: p.manufacturer as string | null,
        serialNumber: p.serialNumber as string | null,
        azureAdDeviceId: p.azureADDeviceId as string | null,
        managementAgent: p.managementAgent as string | null,
        jailBroken: p.jailBroken as string | null,
        coreHash: canonicalHash(p),
        firstSeenAt: ctx.now,
        lastChangedAt: ctx.now,
        isStale: false,
        staleSince: null,
      },
    };
  });

  await writeEntityChunks(plan.rows, async (chunk) => {
    await db.insert(m365IntuneDevices).values(chunk).onConflictDoUpdate({
      target: [m365IntuneDevices.orgId, m365IntuneDevices.graphId],
      // breeze_device_id is deliberately ABSENT: it is written only by W05's
      // link reconciliation, and listing it here would null an existing link on
      // every run.
      set: {
        deviceName: sqlExcluded('device_name'),
        operatingSystem: sqlExcluded('operating_system'),
        osVersion: sqlExcluded('os_version'),
        complianceState: sqlExcluded('compliance_state'),
        lastIntuneSyncAt: sqlExcluded('last_intune_sync_at'),
        userPrincipalName: sqlExcluded('user_principal_name'),
        ownerType: sqlExcluded('owner_type'),
        enrolledAt: sqlExcluded('enrolled_at'),
        model: sqlExcluded('model'),
        manufacturer: sqlExcluded('manufacturer'),
        serialNumber: sqlExcluded('serial_number'),
        azureAdDeviceId: sqlExcluded('azure_ad_device_id'),
        managementAgent: sqlExcluded('management_agent'),
        jailBroken: sqlExcluded('jail_broken'),
        coreHash: sqlExcluded('core_hash'),
        lastChangedAt: sqlExcluded('last_changed_at'),
        isStale: sqlFalse(),
        staleSince: sqlNull(),
      },
    });
  });

  const stale = plan.staleIds.length
    ? await markEntitiesStale(m365IntuneDevices as never, ctx.orgId, plan.staleIds, ctx.now)
    : 0;

  const counts: Record<string, number> = {
    devices_total: items.length,
    devices_compliant: 0,
    devices_noncompliant: 0,
    devices_in_grace: 0,
    devices_unknown: 0,
  };
  for (const item of items) counts[complianceBucket(item.complianceState)] += 1;

  return { inserted: plan.inserted, updated: plan.updated, unchanged: plan.unchanged, stale, complete, counts };
}
```

- [ ] **Step 4: Run — must PASS**

```bash
cd apps/api && npx vitest run src/services/m365Sync/domains/intuneDevices.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/domains/intuneDevices.ts apps/api/src/services/m365Sync/domains/intuneDevices.test.ts
git commit -m "$(cat <<'EOF'
feat(m365): add the Intune devices persister

Compliance state passes through raw; only the rollup counters bucket it, and
`unknown`/`configManager` bucket as unknown rather than non-compliant so a
missing verdict cannot invent a security finding.

breeze_device_id is absent from both the insert values and the conflict SET:
link reconciliation is W05, and listing the column here would null an
existing link on every run.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 10: `domains/caPolicies.ts`

Spec §3.2: `definition_hash` = hash of `state` + `conditions` + `grant_controls` + `session_controls` — "a rename is not a policy change; disabling is". §5.9: counts by state.

**Files:**
- Create: `apps/api/src/services/m365Sync/domains/caPolicies.ts`
- Create: `apps/api/src/services/m365Sync/domains/caPolicies.test.ts`

**Interfaces:** produces `persistCaPolicies(ctx, result)`; consumes `m365CaPolicies` from W02.

- [ ] **Step 1: Write the failing test** (same db-mock preamble):

```ts
import { persistCaPolicies } from './caPolicies';

const policy = (over = {}) => ({
  id: 'p1', displayName: 'Require MFA', state: 'enabled',
  createdDateTime: '2025-01-01T00:00:00Z', modifiedDateTime: '2026-01-01T00:00:00Z',
  conditions: { users: { includeUsers: ['All'] } },
  grantControls: { builtInControls: ['mfa'] },
  sessionControls: null,
  ...over,
});
const okResult = (items: unknown[], over = {}) => ({
  success: true as const, kind: 'sync' as const, items: items as Record<string, unknown>[],
  truncated: false, fetchedAt: '2026-09-08T00:00:00.000Z',
  sources: { policies: 'ok' as const }, ...over,
});

describe('persistCaPolicies', () => {
  beforeEach(() => { vi.clearAllMocks(); dbMocks.inserted = []; dbMocks.setPayloads = []; dbMocks.updates = []; });

  it('a RENAME does not move definition_hash (spec §3.2)', async () => {
    await persistCaPolicies(ctx(), okResult([policy()]));
    const before = (dbMocks.inserted[0] as { definitionHash: string }).definitionHash;
    dbMocks.inserted = [];
    await persistCaPolicies(ctx(), okResult([policy({ displayName: 'Require MFA (renamed)' })]));
    expect((dbMocks.inserted[0] as { definitionHash: string }).definitionHash).toBe(before);
  });

  it('DISABLING does move definition_hash — state is inside it', async () => {
    await persistCaPolicies(ctx(), okResult([policy()]));
    const before = (dbMocks.inserted[0] as { definitionHash: string }).definitionHash;
    dbMocks.inserted = [];
    await persistCaPolicies(ctx(), okResult([policy({ state: 'disabled' })]));
    expect((dbMocks.inserted[0] as { definitionHash: string }).definitionHash).not.toBe(before);
  });

  it('a grant-control change moves definition_hash', async () => {
    await persistCaPolicies(ctx(), okResult([policy()]));
    const before = (dbMocks.inserted[0] as { definitionHash: string }).definitionHash;
    dbMocks.inserted = [];
    await persistCaPolicies(ctx(), okResult([policy({ grantControls: { builtInControls: ['block'] } })]));
    expect((dbMocks.inserted[0] as { definitionHash: string }).definitionHash).not.toBe(before);
  });

  it('a rename IS a core change, so the row is still rewritten', async () => {
    await persistCaPolicies(ctx(), okResult([policy()]));
    const coreHash = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = [];
    const out = await persistCaPolicies(
      ctx([['p1', { coreHash, isStale: false }]]),
      okResult([policy({ displayName: 'Renamed' })]),
    );
    expect(out.updated).toBe(1);
    expect(dbMocks.inserted).toHaveLength(1);
  });

  it('counts by state under the ROLLUP column names, mapping enabledForReportingButNotEnforced to report-only', async () => {
    const out = await persistCaPolicies(ctx(), okResult([
      policy({ id: 'a', state: 'enabled' }),
      policy({ id: 'b', state: 'disabled' }),
      policy({ id: 'c', state: 'enabledForReportingButNotEnforced' }),
      policy({ id: 'd', state: 'enabled' }),
      policy({ id: 'e', state: null }),
    ]));
    // EXACTLY the three m365_posture_rollups column names, nothing else:
    // last_counts is read straight into the rollup by key, so a key with no
    // column (a `ca_policies_total`, say) is silently dropped there and reads
    // as an invented counter here.
    expect(out.counts).toEqual({
      ca_policies_enabled: 2, ca_policies_report_only: 1, ca_policies_disabled: 1,
    });
  });

  it('stores the three control objects as jsonb, defaulting a missing one to null not {}', async () => {
    await persistCaPolicies(ctx(), okResult([policy({ sessionControls: undefined })]));
    expect(dbMocks.inserted[0]).toMatchObject({ sessionControls: null });
    expect(dbMocks.inserted[0]).toHaveProperty('conditions');
    expect(dbMocks.inserted[0]).toHaveProperty('grantControls');
  });

  it('is complete only when policies returned ok and nothing truncated', async () => {
    expect((await persistCaPolicies(ctx(), okResult([policy()]))).complete).toBe(true);
    expect((await persistCaPolicies(ctx(), okResult([policy()], { truncated: true }))).complete).toBe(false);
  });

  it('writes nothing on an identical second run', async () => {
    await persistCaPolicies(ctx(), okResult([policy()]));
    const coreHash = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = [];
    const out = await persistCaPolicies(ctx([['p1', { coreHash, isStale: false }]]), okResult([policy()]));
    expect(dbMocks.inserted).toEqual([]);
    expect(out.unchanged).toBe(1);
  });
});
```

- [ ] **Step 2: Run — must FAIL**

```bash
cd apps/api && npx vitest run src/services/m365Sync/domains/caPolicies.test.ts
```

- [ ] **Step 3: Implement** — `apps/api/src/services/m365Sync/domains/caPolicies.ts`:

```ts
import { db } from '../../../db';
import { m365CaPolicies } from '../../../db/schema';
import { canonicalHash } from '../hash';
import {
  M365_SYNC_PRIMARY_SOURCE_KEY,
  type DomainPersistResult, type M365SyncActionResult, type PersistContext,
} from '../types';
import {
  markEntitiesStale, planEntityWrites, sqlExcluded, sqlFalse, sqlNull, writeEntityChunks,
} from './persist';

interface PolicyItem {
  id?: string;
  displayName?: string | null;
  state?: string | null;
  createdDateTime?: string | null;
  modifiedDateTime?: string | null;
  conditions?: unknown;
  grantControls?: unknown;
  sessionControls?: unknown;
}

/**
 * `core_hash` covers the whole projection (a rename is still a row change worth
 * persisting), while `definition_hash` covers ONLY what changes the policy's
 * effect: state + the three control objects. Sub-project 3's change alerts key
 * on definition_hash, so a rename must not page anyone — and disabling a policy
 * must (spec §3.2). Keeping the two hashes separate is the whole reason the
 * column exists.
 */
function coreProjection(item: PolicyItem): Record<string, unknown> {
  return {
    displayName: item.displayName ?? null,
    state: item.state ?? null,
    createdDateTime: item.createdDateTime ?? null,
    modifiedDateTime: item.modifiedDateTime ?? null,
    conditions: item.conditions ?? null,
    grantControls: item.grantControls ?? null,
    sessionControls: item.sessionControls ?? null,
  };
}

function definitionProjection(item: PolicyItem): Record<string, unknown> {
  return {
    state: item.state ?? null,
    conditions: item.conditions ?? null,
    grantControls: item.grantControls ?? null,
    sessionControls: item.sessionControls ?? null,
  };
}

export async function persistCaPolicies(
  ctx: PersistContext,
  result: M365SyncActionResult,
): Promise<DomainPersistResult> {
  const items = result.items as PolicyItem[];
  const primaryOk = result.sources[M365_SYNC_PRIMARY_SOURCE_KEY.ca_policies] === 'ok';
  const complete = primaryOk && !result.truncated;

  const plan = planEntityWrites(ctx, items, complete, (item) => {
    if (!item.id) return null;
    const core = coreProjection(item);
    return {
      graphId: item.id,
      coreHash: canonicalHash(core),
      row: {
        orgId: ctx.orgId,
        graphId: item.id,
        displayName: core.displayName as string | null,
        state: core.state as string | null,
        graphCreatedAt: core.createdDateTime ? new Date(core.createdDateTime as string) : null,
        graphModifiedAt: core.modifiedDateTime ? new Date(core.modifiedDateTime as string) : null,
        conditions: item.conditions ?? null,
        grantControls: item.grantControls ?? null,
        sessionControls: item.sessionControls ?? null,
        definitionHash: canonicalHash(definitionProjection(item)),
        coreHash: canonicalHash(core),
        firstSeenAt: ctx.now,
        lastChangedAt: ctx.now,
        isStale: false,
        staleSince: null,
      },
    };
  });

  await writeEntityChunks(plan.rows, async (chunk) => {
    await db.insert(m365CaPolicies).values(chunk).onConflictDoUpdate({
      target: [m365CaPolicies.orgId, m365CaPolicies.graphId],
      set: {
        displayName: sqlExcluded('display_name'),
        state: sqlExcluded('state'),
        graphCreatedAt: sqlExcluded('graph_created_at'),
        graphModifiedAt: sqlExcluded('graph_modified_at'),
        conditions: sqlExcluded('conditions'),
        grantControls: sqlExcluded('grant_controls'),
        sessionControls: sqlExcluded('session_controls'),
        definitionHash: sqlExcluded('definition_hash'),
        coreHash: sqlExcluded('core_hash'),
        lastChangedAt: sqlExcluded('last_changed_at'),
        isStale: sqlFalse(),
        staleSince: sqlNull(),
      },
    });
  });

  const stale = plan.staleIds.length
    ? await markEntitiesStale(m365CaPolicies as never, ctx.orgId, plan.staleIds, ctx.now)
    : 0;

  // Keys are m365_posture_rollups COLUMN names (spec §5.9). The rollup reads
  // last_counts by key, so a key without a matching column is dead weight —
  // there is deliberately no `ca_policies_total`.
  const counts: Record<string, number> = {
    ca_policies_enabled: 0,
    ca_policies_report_only: 0,
    ca_policies_disabled: 0,
  };
  for (const item of items) {
    switch ((item.state ?? '').trim()) {
      case 'enabled': counts.ca_policies_enabled += 1; break;
      case 'enabledForReportingButNotEnforced': counts.ca_policies_report_only += 1; break;
      case 'disabled': counts.ca_policies_disabled += 1; break;
      default: break;   // an unrecognised state lands in NO bucket, never guessed into one
    }
  }

  return { inserted: plan.inserted, updated: plan.updated, unchanged: plan.unchanged, stale, complete, counts };
}
```

- [ ] **Step 4: Run — must PASS**

```bash
cd apps/api && npx vitest run src/services/m365Sync/domains/caPolicies.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/domains/caPolicies.ts apps/api/src/services/m365Sync/domains/caPolicies.test.ts
git commit -m "$(cat <<'EOF'
feat(m365): add the Conditional Access policy persister

definition_hash covers state + conditions + grant + session controls only, so
a rename does not move it and disabling does (spec §3.2) — sub-project 3's
change alerts key on it and must not page on a rename. core_hash still covers
the whole projection, so the renamed row is persisted.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 11: `domains/skus.ts`

Spec §3.2 (`m365_license_skus`), §5.9 (`seats_purchased` = Σ `prepaidUnits.enabled`, `seats_consumed` = Σ `consumedUnits`).

> **There is NO `sku_id` column on `m365_license_skus`.** `graph_id` holds the Graph `skuId`, exactly as it holds the Graph `id` on the other three entity tables — that is what lets one `(org_id, graph_id)` unique key, one `PersistContext.existing` map shape and one stale planner serve every domain. Writing `skuId` into the row object or `sqlExcluded('sku_id')` into the conflict SET is a column that does not exist: a 42703 at runtime that no mocked test can see.

**Files:**
- Create: `apps/api/src/services/m365Sync/domains/skus.ts`
- Create: `apps/api/src/services/m365Sync/domains/skus.test.ts`

**Interfaces:** produces `persistSkus(ctx, result)`; consumes `m365LicenseSkus` from W02.

- [ ] **Step 1: Write the failing test** (same preamble):

```ts
import { persistSkus } from './skus';

const sku = (over = {}) => ({
  skuId: '33333333-3333-4333-8333-333333333333', skuPartNumber: 'ENTERPRISEPACK',
  consumedUnits: 12, prepaidUnits: { enabled: 25, suspended: 0, warning: 1 },
  capabilityStatus: 'Enabled', appliesTo: 'User', ...over,
});
const okResult = (items: unknown[], over = {}) => ({
  success: true as const, kind: 'sync' as const, items: items as Record<string, unknown>[],
  truncated: false, fetchedAt: '2026-09-08T00:00:00.000Z',
  sources: { subscribedSkus: 'ok' as const }, ...over,
});

describe('persistSkus', () => {
  beforeEach(() => { vi.clearAllMocks(); dbMocks.inserted = []; dbMocks.setPayloads = []; dbMocks.updates = []; });

  it('keys the row on graph_id = the Graph skuId, and writes NO sku_id column', async () => {
    await persistSkus(ctx(), okResult([sku()]));
    expect(dbMocks.inserted[0]).toMatchObject({
      graphId: '33333333-3333-4333-8333-333333333333',
      skuPartNumber: 'ENTERPRISEPACK',
    });
    // m365_license_skus has no sku_id column — writing one is a 42703 that a
    // mocked db would happily accept, so pin its absence here.
    expect(dbMocks.inserted[0]).not.toHaveProperty('skuId');
    expect(dbMocks.setPayloads[0]).not.toHaveProperty('skuId');
  });

  it('flattens prepaidUnits into three integer columns', async () => {
    await persistSkus(ctx(), okResult([sku()]));
    expect(dbMocks.inserted[0]).toMatchObject({
      consumedUnits: 12, prepaidEnabled: 25, prepaidSuspended: 0, prepaidWarning: 1,
    });
  });

  it('defaults a missing prepaidUnits to zeros rather than writing NULL seat counts', async () => {
    await persistSkus(ctx(), okResult([sku({ prepaidUnits: undefined })]));
    expect(dbMocks.inserted[0]).toMatchObject({ prepaidEnabled: 0, prepaidSuspended: 0, prepaidWarning: 0 });
  });

  it('sums seats_purchased and seats_consumed across every sku', async () => {
    const out = await persistSkus(ctx(), okResult([
      sku(),
      sku({ skuId: '44444444-4444-4444-8444-444444444444', consumedUnits: 3, prepaidUnits: { enabled: 10, suspended: 2, warning: 0 } }),
    ]));
    expect(out.counts).toEqual({ seats_purchased: 35, seats_consumed: 15 });   // rollup column names only
  });

  it('does not let a non-numeric unit count poison the sums', async () => {
    const out = await persistSkus(ctx(), okResult([sku({ consumedUnits: null, prepaidUnits: { enabled: 'x' } })]));
    expect(out.counts.seats_consumed).toBe(0);
    expect(out.counts.seats_purchased).toBe(0);
  });

  it('writes nothing on an identical second run', async () => {
    await persistSkus(ctx(), okResult([sku()]));
    const coreHash = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = [];
    const out = await persistSkus(
      ctx([['33333333-3333-4333-8333-333333333333', { coreHash, isStale: false }]]),
      okResult([sku()]),
    );
    expect(dbMocks.inserted).toEqual([]);
    expect(out.unchanged).toBe(1);
  });

  it('a seat-count change IS a change', async () => {
    await persistSkus(ctx(), okResult([sku()]));
    const coreHash = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = [];
    const out = await persistSkus(
      ctx([['33333333-3333-4333-8333-333333333333', { coreHash, isStale: false }]]),
      okResult([sku({ consumedUnits: 13 })]),
    );
    expect(out.updated).toBe(1);
  });

  it('marks a removed subscription stale on a complete run', async () => {
    const out = await persistSkus(ctx([['gone', { coreHash: 'h', isStale: false }]]), okResult([sku()]));
    expect(out.stale).toBe(1);
  });
});
```

- [ ] **Step 2: Run — must FAIL**

```bash
cd apps/api && npx vitest run src/services/m365Sync/domains/skus.test.ts
```

- [ ] **Step 3: Implement** — `apps/api/src/services/m365Sync/domains/skus.ts`:

```ts
import { db } from '../../../db';
import { m365LicenseSkus } from '../../../db/schema';
import { canonicalHash } from '../hash';
import {
  M365_SYNC_PRIMARY_SOURCE_KEY,
  type DomainPersistResult, type M365SyncActionResult, type PersistContext,
} from '../types';
import {
  markEntitiesStale, planEntityWrites, sqlExcluded, sqlFalse, sqlNull, writeEntityChunks,
} from './persist';

interface SkuItem {
  skuId?: string;
  skuPartNumber?: string | null;
  consumedUnits?: number | null;
  prepaidUnits?: { enabled?: number | null; suspended?: number | null; warning?: number | null } | null;
  capabilityStatus?: string | null;
  appliesTo?: string | null;
}

/**
 * Seat counts feed a licensing view and the rollup, so a non-numeric value must
 * become 0, never NaN: one NaN would make `seats_purchased` NaN for the whole
 * org and the rollup would render "—" for a tenant that has licences.
 */
function unitCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function projection(item: SkuItem): Record<string, unknown> {
  return {
    skuPartNumber: item.skuPartNumber ?? null,
    consumedUnits: unitCount(item.consumedUnits),
    prepaidEnabled: unitCount(item.prepaidUnits?.enabled),
    prepaidSuspended: unitCount(item.prepaidUnits?.suspended),
    prepaidWarning: unitCount(item.prepaidUnits?.warning),
    capabilityStatus: item.capabilityStatus ?? null,
    appliesTo: item.appliesTo ?? null,
  };
}

export async function persistSkus(
  ctx: PersistContext,
  result: M365SyncActionResult,
): Promise<DomainPersistResult> {
  const items = result.items as SkuItem[];
  const primaryOk = result.sources[M365_SYNC_PRIMARY_SOURCE_KEY.skus] === 'ok';
  const complete = primaryOk && !result.truncated;

  const plan = planEntityWrites(ctx, items, complete, (item) => {
    if (!item.skuId) return null;
    const p = projection(item);
    return {
      // graph_id carries the Graph `skuId` (spec §3.2). There is NO separate
      // sku_id column: one column shape across all four domains is what lets
      // planEntityWrites, markEntitiesStale and PersistContext.existing be
      // written once.
      graphId: item.skuId,
      coreHash: canonicalHash(p),
      row: {
        orgId: ctx.orgId,
        graphId: item.skuId,
        skuPartNumber: p.skuPartNumber as string | null,
        consumedUnits: p.consumedUnits as number,
        prepaidEnabled: p.prepaidEnabled as number,
        prepaidSuspended: p.prepaidSuspended as number,
        prepaidWarning: p.prepaidWarning as number,
        capabilityStatus: p.capabilityStatus as string | null,
        appliesTo: p.appliesTo as string | null,
        coreHash: canonicalHash(p),
        firstSeenAt: ctx.now,
        lastChangedAt: ctx.now,
        isStale: false,
        staleSince: null,
      },
    };
  });

  await writeEntityChunks(plan.rows, async (chunk) => {
    await db.insert(m365LicenseSkus).values(chunk).onConflictDoUpdate({
      target: [m365LicenseSkus.orgId, m365LicenseSkus.graphId],
      set: {
        skuPartNumber: sqlExcluded('sku_part_number'),
        consumedUnits: sqlExcluded('consumed_units'),
        prepaidEnabled: sqlExcluded('prepaid_enabled'),
        prepaidSuspended: sqlExcluded('prepaid_suspended'),
        prepaidWarning: sqlExcluded('prepaid_warning'),
        capabilityStatus: sqlExcluded('capability_status'),
        appliesTo: sqlExcluded('applies_to'),
        coreHash: sqlExcluded('core_hash'),
        lastChangedAt: sqlExcluded('last_changed_at'),
        isStale: sqlFalse(),
        staleSince: sqlNull(),
      },
    });
  });

  const stale = plan.staleIds.length
    ? await markEntitiesStale(m365LicenseSkus as never, ctx.orgId, plan.staleIds, ctx.now)
    : 0;

  let seatsPurchased = 0;
  let seatsConsumed = 0;
  for (const item of items) {
    seatsPurchased += unitCount(item.prepaidUnits?.enabled);
    seatsConsumed += unitCount(item.consumedUnits);
  }

  return {
    inserted: plan.inserted, updated: plan.updated, unchanged: plan.unchanged, stale, complete,
    // Rollup column names only (spec §5.9) — there is no `skus_total` column.
    counts: { seats_purchased: seatsPurchased, seats_consumed: seatsConsumed },
  };
}
```

- [ ] **Step 4: Run — must PASS**

```bash
cd apps/api && npx vitest run src/services/m365Sync/domains
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/domains/skus.ts apps/api/src/services/m365Sync/domains/skus.test.ts
git commit -m "$(cat <<'EOF'
feat(m365): add the license SKU persister

Keyed on graph_id, which holds the Graph skuId (there is no sku_id column), so
the shared unique key and the stale planner work unchanged across all four
domains. prepaidUnits is flattened into three integer columns,
and seat sums computed in memory. A non-numeric unit count becomes 0 rather
than NaN — one NaN would blank seats_purchased for the whole org.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 12: `run.ts` Phase A — snapshot, fencing, existing-hash map

Spec §5.3 Phase A: "Exit as a no-op, clearing the lease, if: the state row is gone; `run_generation` ≠ the job's generation; the connection is not executable; or `connection.id`/`tenantId`/`consentGeneration` differ from the job's." Plus the Phase C re-check under `FOR UPDATE`.

**Files:**
- Create: `apps/api/src/services/m365Sync/run.ts` (Phase A only; Task 13 completes it)
- Create: `apps/api/src/services/m365Sync/run.phaseA.test.ts`
- Create: `apps/api/src/services/m365Sync/cadence.ts`
- Create: `apps/api/src/services/m365Sync/cadence.test.ts`
- Create: `apps/api/src/services/m365Sync/hooks.ts`

**Interfaces:**
- Consumes: `connectionExecutionSnapshot` (Task 3), `m365SyncState` + entity tables (W02), `M365_SYNC_LEASE_MINUTES` (Task 4).
- Produces (used by Task 13 and by W05):

```ts
// run.ts
export interface SyncRunContext {
  snapshot: M365ConnectionExecutionSnapshot;
  state: {
    intervalSeconds: number;
    continuation: string | null;
    lastCompleteSnapshotAt: Date | null;
    /** Drives `backfill` for secure_score in Phase B. Selected in Phase A. */
    lastSuccessAt: Date | null;
  };
  existing: Map<string, { coreHash: string; isStale: boolean }>;
}
export type FenceReason = 'state_missing' | 'generation_mismatch' | 'connection_not_executable'
  | 'connection_changed' | 'tenant_changed' | 'consent_changed';
export async function loadSyncRunContext(data: M365SyncJobData): Promise<SyncRunContext | { fenced: FenceReason }>;
export async function assertStillFenced(data: M365SyncJobData): Promise<FenceReason | null>;  // Phase C re-check, FOR UPDATE
export async function releaseLease(data: M365SyncJobData): Promise<void>;

// cadence.ts — W04 CREATES it; W05 replaces the applyCadence BODY (spec §5.7).
// Returns the PAIR, so run.ts never computes a due time itself.
export function applyCadence(
  domain: M365SyncDomain,
  state: { intervalSeconds: number },
  outcome: M365SyncOutcome,
  signals: CadenceSignals,
  rng?: () => number,          // optional, additive: injectable jitter for tests
): { intervalSeconds: number; nextSyncAt: Date | null };
export function nextSyncAt(now: Date, intervalSeconds: number, rng?: () => number): Date;  // +/-10% jitter
export type { CadenceSignals };   // re-exported from types.ts for W05's convenience

// hooks.ts — W04 CREATES it as a no-op; W05 fills the BODY.
export async function afterDomainPersisted(
  ctx: PersistContext & { domain: M365SyncDomain; outcome: M365SyncOutcome; persisted: DomainPersistResult },
): Promise<void>;
```

- [ ] **Step 1: Write the failing test** — `run.phaseA.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMocks } = vi.hoisted(() => ({
  dbMocks: { rows: [] as unknown[][], selectCalls: 0, depth: 0, maxDepthAtSelect: 0, updates: [] as unknown[] },
}));

vi.mock('../../db', () => ({
  db: {
    select: () => { dbMocks.selectCalls += 1; dbMocks.maxDepthAtSelect = dbMocks.depth;
      const chain = { from: () => chain, innerJoin: () => chain, where: () => chain, limit: () => chain, for: () => chain,
        then: (res: (v: unknown) => unknown) => Promise.resolve(dbMocks.rows.shift() ?? []).then(res) };
      return chain; },
    update: () => ({ set: () => ({ where: () => { dbMocks.updates.push(true); return Promise.resolve(); } }) }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    dbMocks.depth += 1; try { return await fn(); } finally { dbMocks.depth -= 1; }
  }),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

import { assertStillFenced, loadSyncRunContext, releaseLease } from './run';

const JOB = {
  orgId: 'org-1', domain: 'users' as const, generation: 5,
  connectionId: 'conn-1', tenantId: 'tenant-1', consentGeneration: 2, priority: 10 as const,
};
const stateRow = (over = {}) => ({
  runGeneration: 5, intervalSeconds: 21600, continuation: null, lastCompleteSnapshotAt: null,
  lastSuccessAt: null, connectionId: 'conn-1', ...over,
});
const connRow = (over = {}) => ({
  id: 'conn-1', orgId: 'org-1', tenantId: 'tenant-1', consentGeneration: 2, status: 'active',
  permissionManifestVersion: 3, vaultRef: 'akv://x', credentialVersion: 'v1', ...over,
});

describe('loadSyncRunContext (Phase A, spec §5.3)', () => {
  beforeEach(() => { vi.clearAllMocks(); dbMocks.rows = []; dbMocks.selectCalls = 0; dbMocks.depth = 0; dbMocks.updates = []; });

  it('reads inside a SYSTEM context — a cross-org scheduler read is denied without one', async () => {
    dbMocks.rows = [[{ ...stateRow(), ...connRow() }], []];
    await loadSyncRunContext(JOB);
    expect(dbMocks.maxDepthAtSelect).toBeGreaterThan(0);
  });

  it('fences when the state row is gone', async () => {
    dbMocks.rows = [[]];
    await expect(loadSyncRunContext(JOB)).resolves.toEqual({ fenced: 'state_missing' });
  });

  it('fences on a generation mismatch — a late job from an expired lease must not persist', async () => {
    dbMocks.rows = [[{ ...stateRow({ runGeneration: 6 }), ...connRow() }]];
    await expect(loadSyncRunContext(JOB)).resolves.toEqual({ fenced: 'generation_mismatch' });
  });

  it.each(['pending-consent', 'verifying', 'suspended', 'revoked'])(
    'fences when the connection is %s', async (status) => {
      dbMocks.rows = [[{ ...stateRow(), ...connRow({ status }) }]];
      await expect(loadSyncRunContext(JOB)).resolves.toEqual({ fenced: 'connection_not_executable' });
    });

  it('fences when the tenant was rebound between claim and run', async () => {
    dbMocks.rows = [[{ ...stateRow(), ...connRow({ tenantId: 'tenant-2' }) }]];
    await expect(loadSyncRunContext(JOB)).resolves.toEqual({ fenced: 'tenant_changed' });
  });

  it('fences when the connection row itself was replaced', async () => {
    dbMocks.rows = [[{ ...stateRow({ connectionId: 'conn-2' }), ...connRow({ id: 'conn-2' }) }]];
    await expect(loadSyncRunContext(JOB)).resolves.toEqual({ fenced: 'connection_changed' });
  });

  it('fences when consent was re-granted (consentGeneration moved)', async () => {
    dbMocks.rows = [[{ ...stateRow(), ...connRow({ consentGeneration: 3 }) }]];
    await expect(loadSyncRunContext(JOB)).resolves.toEqual({ fenced: 'consent_changed' });
  });

  it('returns the snapshot, the stored interval, and the existing hash map on the happy path', async () => {
    dbMocks.rows = [
      [{ ...stateRow(), ...connRow() }],
      [{ graphId: 'u1', coreHash: 'h1', isStale: false }, { graphId: 'u2', coreHash: 'h2', isStale: true }],
    ];
    const ctx = await loadSyncRunContext(JOB) as { snapshot: unknown; state: { intervalSeconds: number; lastSuccessAt: Date | null }; existing: Map<string, unknown> };
    expect(ctx.snapshot).toMatchObject({ id: 'conn-1', orgId: 'org-1', tenantId: 'tenant-1', consentGeneration: 2 });
    expect(ctx.state.intervalSeconds).toBe(21600);
    // last_success_at is what Phase B turns into `backfill` for secure_score;
    // omitting it from the SELECT would make every secure_score run a backfill.
    expect(ctx.state.lastSuccessAt).toBeNull();
    expect(ctx.existing.get('u1')).toEqual({ coreHash: 'h1', isStale: false });
    expect(ctx.existing.get('u2')).toEqual({ coreHash: 'h2', isStale: true });
  });

  it('carries a non-null last_success_at through, so a repeat run is not treated as a backfill', async () => {
    const lastSuccess = new Date('2026-09-01T00:00:00.000Z');
    dbMocks.rows = [[{ ...stateRow({ lastSuccessAt: lastSuccess }), ...connRow() }], []];
    const ctx = await loadSyncRunContext(JOB) as { state: { lastSuccessAt: Date | null } };
    expect(ctx.state.lastSuccessAt).toEqual(lastSuccess);
  });

  it('does NOT read the entity hash map when it fenced — one wasted 25k-row scan per late job', async () => {
    dbMocks.rows = [[]];
    await loadSyncRunContext(JOB);
    expect(dbMocks.selectCalls).toBe(1);
  });
});

describe('assertStillFenced (Phase C re-check)', () => {
  beforeEach(() => { vi.clearAllMocks(); dbMocks.rows = []; dbMocks.depth = 0; });

  it('returns null when nothing moved during the fetch', async () => {
    dbMocks.rows = [[{ ...stateRow(), ...connRow() }]];
    await expect(assertStillFenced(JOB)).resolves.toBeNull();
  });

  it('detects a disconnect that happened DURING the Graph fetch', async () => {
    dbMocks.rows = [[{ ...stateRow(), ...connRow({ status: 'revoked', tenantId: null }) }]];
    await expect(assertStillFenced(JOB)).resolves.toBe('connection_not_executable');
  });

  it('detects a re-claim that happened during the fetch', async () => {
    dbMocks.rows = [[{ ...stateRow({ runGeneration: 6 }), ...connRow() }]];
    await expect(assertStillFenced(JOB)).resolves.toBe('generation_mismatch');
  });
});

describe('releaseLease', () => {
  it('clears the lease without touching next_sync_at, so the row stays due', async () => {
    await releaseLease(JOB);
    expect(dbMocks.updates).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run — must FAIL**

```bash
cd apps/api && npx vitest run src/services/m365Sync/run.phaseA.test.ts src/services/m365Sync/cadence.test.ts
```

- [ ] **Step 3: Implement**

`apps/api/src/services/m365Sync/cadence.ts`:

```ts
import type { M365SyncDomain } from '@breeze/shared/m365';
import type { CadenceSignals, M365SyncOutcome } from './types';

export type { CadenceSignals };

/**
 * next run = now + interval, jittered +/-10%. Without the jitter every org
 * seeded in the same tick would stay in lockstep forever and the fleet would
 * re-converge into the same minute every six hours.
 *
 * Lives HERE rather than in run.ts because it is the second half of the cadence
 * decision: W05 needs to change the interval and the due time together, and a
 * jitter helper on the other side of that seam would be edited from two places.
 */
export function nextSyncAt(now: Date, intervalSeconds: number, rng: () => number = Math.random): Date {
  const jitter = 0.9 + rng() * 0.2;
  return new Date(now.getTime() + Math.round(intervalSeconds * 1000 * jitter));
}

/**
 * SEAM — the BODY is owned by W05 (spec §5.7 adaptive cadence).
 *
 * W04 returns the stored interval unchanged, so a run's cadence is exactly what
 * `m365_sync_state.interval_seconds` says, plus the jittered due time. W05
 * replaces the interval computation with the clamped ladder from
 * `M365_SYNC_DOMAIN_INTERVAL_BOUNDS` (x2 on truncated or >60 s latency, x1.5 on
 * throttled/capacity, 25 % decay toward the default on success) and may return
 * `nextSyncAt: null` to unschedule.
 *
 * It returns the PAIR, not just a number: `next_sync_at` and `interval_seconds`
 * are written in the same statement and must be decided together, and run.ts
 * having its own due-time helper is exactly how the two drift apart. `rng` is
 * an optional fifth argument purely so a test can pin the jitter; the
 * four-argument contract call still type-checks.
 */
export function applyCadence(
  _domain: M365SyncDomain,
  state: { intervalSeconds: number },
  _outcome: M365SyncOutcome,
  signals: CadenceSignals,
  rng?: () => number,
): { intervalSeconds: number; nextSyncAt: Date | null } {
  return {
    intervalSeconds: state.intervalSeconds,
    nextSyncAt: nextSyncAt(signals.now, state.intervalSeconds, rng),
  };
}
```

`apps/api/src/services/m365Sync/cadence.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyCadence, nextSyncAt } from './cadence';

const NOW = new Date('2026-09-08T00:00:00.000Z');
const signals = (over = {}) => ({
  truncated: false, latencyMs: 1200, capacity: false,
  unlicensed: false, authFailure: false, now: NOW, ...over,
});

describe('nextSyncAt', () => {
  it('applies at most +/-10% jitter around the interval', () => {
    expect(nextSyncAt(NOW, 3600, () => 0).getTime() - NOW.getTime()).toBe(3600 * 1000 * 0.9);
    expect(nextSyncAt(NOW, 3600, () => 1).getTime() - NOW.getTime()).toBe(3600 * 1000 * 1.1);
    expect(nextSyncAt(NOW, 3600, () => 0.5).getTime() - NOW.getTime()).toBe(3600 * 1000);
  });

  it('spreads two orgs on the same interval, so a cohort does not re-converge', () => {
    expect(nextSyncAt(NOW, 3600, () => 0.1).getTime()).not.toBe(nextSyncAt(NOW, 3600, () => 0.9).getTime());
  });
});

describe('applyCadence (W04 stub — W05 replaces the body)', () => {
  it('returns the STORED interval unchanged on every outcome', () => {
    for (const outcome of ['success', 'partial', 'needs_consent', 'throttled', 'error'] as const) {
      expect(applyCadence('users', { intervalSeconds: 21600 }, outcome, signals(), () => 0.5))
        .toEqual({ intervalSeconds: 21600, nextSyncAt: new Date(NOW.getTime() + 21600 * 1000) });
    }
  });

  it('derives next_sync_at from signals.now, not from a clock read inside the seam', () => {
    const other = new Date('2027-01-01T00:00:00.000Z');
    const { nextSyncAt: due } = applyCadence('skus', { intervalSeconds: 3600 }, 'success', signals({ now: other }), () => 0.5);
    expect(due!.getTime()).toBe(other.getTime() + 3600 * 1000);
  });

  it('accepts all six signals, so W05 has every one of them available', () => {
    expect(() => applyCadence('signin_activity', { intervalSeconds: 86400 }, 'partial',
      signals({ truncated: true, capacity: true, unlicensed: true, authFailure: true }))).not.toThrow();
  });
});
```

`apps/api/src/services/m365Sync/hooks.ts`:

```ts
import type { M365SyncDomain } from '@breeze/shared/m365';
import type { DomainPersistResult, M365SyncOutcome, PersistContext } from './types';

/**
 * SEAM — the BODY is owned by W05.
 *
 * Called once per domain immediately AFTER its completion transaction has
 * COMMITTED, with no DB context held: W05's implementation opens its own. It
 * fills this with `upsertPostureRollup` (spec §5.9) and, for `intune_devices`,
 * `reconcileDeviceLinks` (spec §5.6) — which is why it takes the full
 * `PersistContext` plus the outcome and the `DomainPersistResult`, everything
 * a rollup needs without a second read.
 *
 * Post-commit on purpose: a rollup upsert or a link-reconciliation pass inside
 * the completion transaction would hold it open for an org-wide scan, and a
 * failure in either would roll back the completion — losing `next_sync_at` and
 * re-running the whole domain next tick. run.ts therefore wraps the call in
 * try/catch and only LOGS; this function must never be relied on to throw.
 */
export async function afterDomainPersisted(
  _ctx: PersistContext & {
    domain: M365SyncDomain;
    outcome: M365SyncOutcome;
    persisted: DomainPersistResult;
  },
): Promise<void> {
  // W05.
}
```

`apps/api/src/services/m365Sync/run.ts` (Phase A half):

```ts
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  m365CaPolicies, m365Connections, m365IntuneDevices, m365LicenseSkus, m365SyncState, m365Users,
} from '../../db/schema';
import {
  connectionExecutionSnapshot, type M365ConnectionExecutionSnapshot,
} from '../m365ControlPlane/readActionService';
import type { M365SyncDomain } from '@breeze/shared/m365';
import type { M365SyncJobData } from './types';

/** The entity table each domain's `(graph_id, core_hash, is_stale)` set lives in. */
const DOMAIN_ENTITY_TABLE = {
  users: m365Users,
  intune_devices: m365IntuneDevices,
  ca_policies: m365CaPolicies,
  skus: m365LicenseSkus,
} as const satisfies Partial<Record<M365SyncDomain, unknown>>;

export type FenceReason =
  | 'state_missing' | 'generation_mismatch' | 'connection_not_executable'
  | 'connection_changed' | 'tenant_changed' | 'consent_changed';

export interface SyncRunContext {
  snapshot: M365ConnectionExecutionSnapshot;
  state: {
    intervalSeconds: number;
    continuation: string | null;
    lastCompleteSnapshotAt: Date | null;
    /**
     * NULL means this domain has never completed for this org. Phase B turns
     * that into `backfill: true` for `secure_score` (spec §5.5). Selecting it
     * here rather than re-reading in Phase B keeps the whole decision inside
     * the one short transaction that already holds the row.
     */
    lastSuccessAt: Date | null;
  };
  existing: Map<string, { coreHash: string; isStale: boolean }>;
}

interface StateAndConnection {
  runGeneration: number;
  intervalSeconds: number;
  continuation: string | null;
  lastCompleteSnapshotAt: Date | null;
  lastSuccessAt: Date | null;
  connectionId: string;
  id: string;
  orgId: string | null;
  tenantId: string | null;
  consentGeneration: number;
  status: string;
  permissionManifestVersion: number;
  vaultRef: string | null;
  credentialVersion: string | null;
}

/**
 * The four fencing conditions of spec §5.3, evaluated identically in Phase A and
 * Phase C. Extracted so the two can never disagree — a Phase C that checked one
 * fewer condition than Phase A would be a silent hole exactly in the window the
 * fence exists for.
 */
function fenceReason(row: StateAndConnection | undefined, data: M365SyncJobData): FenceReason | null {
  if (!row) return 'state_missing';
  if (Number(row.runGeneration) !== data.generation) return 'generation_mismatch';
  if (row.connectionId !== data.connectionId || row.id !== data.connectionId) return 'connection_changed';
  if (!connectionExecutionSnapshot(row as never)) return 'connection_not_executable';
  if (row.tenantId !== data.tenantId) return 'tenant_changed';
  if (Number(row.consentGeneration) !== data.consentGeneration) return 'consent_changed';
  return null;
}

function selectStateAndConnection(data: M365SyncJobData, forUpdate: boolean) {
  const query = db.select({
    runGeneration: m365SyncState.runGeneration,
    intervalSeconds: m365SyncState.intervalSeconds,
    continuation: m365SyncState.continuation,
    lastCompleteSnapshotAt: m365SyncState.lastCompleteSnapshotAt,
    lastSuccessAt: m365SyncState.lastSuccessAt,
    connectionId: m365SyncState.connectionId,
    id: m365Connections.id,
    orgId: m365Connections.orgId,
    tenantId: m365Connections.tenantId,
    consentGeneration: m365Connections.consentGeneration,
    status: m365Connections.status,
    permissionManifestVersion: m365Connections.permissionManifestVersion,
    vaultRef: m365Connections.vaultRef,
    credentialVersion: m365Connections.credentialVersion,
  })
    .from(m365SyncState)
    .innerJoin(m365Connections, and(
      eq(m365Connections.id, m365SyncState.connectionId),
      eq(m365Connections.orgId, m365SyncState.orgId),
    ))
    .where(and(
      eq(m365SyncState.orgId, data.orgId),
      eq(m365SyncState.domain, data.domain),
    ))
    .limit(1);
  return forUpdate ? query.for('update') : query;
}

/**
 * PHASE A (spec §5.3): one short system transaction that loads the connection
 * snapshot, the state row, and — only if the run is going ahead — the org's
 * existing `(graph_id, core_hash, is_stale)` set. It COMMITS before the fetch:
 * holding this open across a 110 s Graph call would pin a pooled connection
 * idle-in-transaction, which is the #1105 failure this whole three-phase shape
 * exists to avoid.
 */
export async function loadSyncRunContext(
  data: M365SyncJobData,
): Promise<SyncRunContext | { fenced: FenceReason }> {
  return withSystemDbAccessContext(async () => {
    const rows = await selectStateAndConnection(data, false);
    const row = rows[0] as StateAndConnection | undefined;

    const fenced = fenceReason(row, data);
    if (fenced) return { fenced };

    const snapshot = connectionExecutionSnapshot(row as never);
    if (!snapshot) return { fenced: 'connection_not_executable' as const };

    const table = DOMAIN_ENTITY_TABLE[data.domain as keyof typeof DOMAIN_ENTITY_TABLE];
    const existing = new Map<string, { coreHash: string; isStale: boolean }>();
    if (table) {
      const entityRows = await db.select({
        graphId: (table as { graphId: never }).graphId,
        coreHash: (table as { coreHash: never }).coreHash,
        isStale: (table as { isStale: never }).isStale,
      }).from(table as never).where(eq((table as { orgId: never }).orgId, data.orgId as never));
      for (const entity of entityRows as Array<{ graphId: string; coreHash: string | null; isStale: boolean }>) {
        existing.set(entity.graphId, { coreHash: entity.coreHash ?? '', isStale: Boolean(entity.isStale) });
      }
    }

    return {
      snapshot,
      state: {
        intervalSeconds: Number(row!.intervalSeconds),
        continuation: row!.continuation,
        lastCompleteSnapshotAt: row!.lastCompleteSnapshotAt,
        lastSuccessAt: row!.lastSuccessAt,
      },
      existing,
    };
  }, 'm365SyncPhaseA');
}

/**
 * PHASE C fence (spec §5.3): re-read state + connection `FOR UPDATE` and apply
 * the SAME conditions. This is what catches a disconnect, a rebind, or a
 * re-claim that happened while we were in Graph. Returns the reason, or null to
 * proceed.
 */
export async function assertStillFenced(data: M365SyncJobData): Promise<FenceReason | null> {
  return withSystemDbAccessContext(async () => {
    const rows = await selectStateAndConnection(data, true);
    return fenceReason(rows[0] as StateAndConnection | undefined, data);
  }, 'm365SyncPhaseCFence');
}

/**
 * Clear the lease WITHOUT advancing next_sync_at, so a no-op leaves the row due
 * and the next tick reclaims it with a fresh generation. Guarded on the
 * generation so a late job cannot release a lease a newer claim now holds.
 */
export async function releaseLease(data: M365SyncJobData): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db.update(m365SyncState)
      .set({ leaseUntil: null, updatedAt: new Date() })
      .where(and(
        eq(m365SyncState.orgId, data.orgId),
        eq(m365SyncState.domain, data.domain),
        eq(m365SyncState.runGeneration, data.generation),
      ));
  }, 'm365SyncReleaseLease');
}

export { DOMAIN_ENTITY_TABLE, sql };
```

- [ ] **Step 4: Run — must PASS**

```bash
cd apps/api && npx vitest run src/services/m365Sync/run.phaseA.test.ts src/services/m365Sync/cadence.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/run.ts apps/api/src/services/m365Sync/run.phaseA.test.ts apps/api/src/services/m365Sync/cadence.ts apps/api/src/services/m365Sync/cadence.test.ts apps/api/src/services/m365Sync/hooks.ts
git commit -m "$(cat <<'EOF'
feat(m365): add sync Phase A snapshot and the shared fencing predicate

One short system transaction loads the connection snapshot, the state row and
the existing hash map, then COMMITS before the fetch — holding it open across
a 110s Graph call is the #1105 failure this three-phase shape exists to avoid.

Phase A and the Phase C FOR UPDATE re-check share ONE fenceReason(), so they
cannot drift: a Phase C checking one fewer condition would be a hole exactly
in the window the fence exists for.

Adds the two W05 seams. applyCadence owns BOTH halves of the cadence decision
(interval and the +/-10%-jittered due time) so run.ts never computes a due
time itself; afterDomainPersisted is a documented post-commit no-op taking the
full PersistContext + outcome + DomainPersistResult, so W05 fills a body
rather than threading new calls into the completion path.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 13: `run.ts` Phases B/C — `runSyncDomain`, outcome mapping, completion, audit

Spec §5.3 Phases B/C, §5.4, §6 (the whole error table), §7 (one audit event per run).

**Files:**
- Edit: `apps/api/src/services/m365Sync/run.ts`
- Create: `apps/api/src/services/m365Sync/audit.ts`
- Create: `apps/api/src/services/m365Sync/run.test.ts`

**Interfaces:**
- Consumes: Task 3 `callGraphReadExecutor`, Task 5 metrics, Tasks 8–11 persisters, Task 12 Phase A, `applyCadence`, `afterDomainPersisted`.
- Produces (used by Task 14 and by W05's on-demand route):

```ts
export async function runSyncDomain(
  data: M365SyncJobData,
  opts?: { isFinalAttempt?: boolean; now?: Date; rng?: () => number;
    callExecutor?: typeof callGraphReadExecutor },
): Promise<M365SyncRunResult>;      // M365SyncRunResult is types.ts's — NOT redeclared here
export function outcomeForFailure(code: M365SyncCallFailureCode): {
  outcome: M365SyncOutcome; unschedule: boolean; sentryWorthy: boolean; restartWalk: boolean;
};
/**
 * The SINGLE completion writer. Nothing else in the wave updates
 * `m365_sync_state` on the completion path.
 *
 *   mode 'complete'     — one short system transaction: last_* fields, sources,
 *                         last_counts, continuation, lease NULL, the
 *                         next_sync_at/interval_seconds pair from `cadence`,
 *                         and ONE structured log line for the run.
 *   mode 'continuation' — stores the continuation and clears the lease, and
 *                         deliberately does NOT touch next_sync_at,
 *                         last_status, last_counts, or write an audit event.
 *                         Used by the 'partial-continue' restart, where the run
 *                         has not finished and must not look as if it had.
 */
async function writeCompletion(
  ctx: { data: M365SyncJobData; now: Date; correlationId: string },
  args:
    | { mode: 'complete'; outcome: M365SyncOutcome; persisted: DomainPersistResult;
        cadence: { intervalSeconds: number; nextSyncAt: Date | null };
        itemCount: number; truncated: boolean; sources: Record<string, string> | null;
        continuation: string | null; lastError: string | null }
    | { mode: 'continuation'; continuation: string | null },
): Promise<void>;
/**
 * All six domains, four with a persister and two `undefined`. A total Record
 * (not a Partial) so W05 adding a domain to `M365SyncDomain` cannot silently
 * leave it unregistered.
 *
 * W05 registers `persistSigninActivity` and `persistSecureScore` here, in the
 * same PR that sets `M365_SYNC_IMPLEMENTED_DOMAINS = M365_SYNC_DOMAINS`.
 */
export const DOMAIN_PERSISTERS: Record<M365SyncDomain, M365DomainPersister | undefined>;
/**
 * The service's one structured-log call: `console.log('[M365Sync] <event>',
 * JSON.stringify(fields))`. `apps/api` has no logger module (verified: the
 * grep for createLogger/pino/logger across `services/m365ControlPlane/*.ts`
 * finds nothing); this matches the repo convention in
 * `jobs/dnsSyncJob.ts:123-146`. The ticker in Task 14 uses it too, so the whole
 * subsystem logs under one tag and one shape.
 */
export function logSync(event: string, fields: Record<string, unknown>): void;
// audit.ts
export function recordM365SyncRunEvent(input: { orgId: string; connectionId: string; domain: M365SyncDomain;
  generation: number; outcome: M365SyncRunResult; correlationId: string; truncated: boolean;
  inserted: number; updated: number; stale: number; unchanged: number }): void;
```

**Ordering of the two seams, stated once so it cannot be re-derived wrongly:**
`applyCadence` is called BEFORE `writeCompletion` (its result is what
`writeCompletion` stores). `afterDomainPersisted` is called AFTER
`writeCompletion` has COMMITTED, outside any DB context — the hook opens its
own — wrapped in try/catch that logs `{orgId, domain, generation, error}` via
the structured logger and never rethrows. **W05 fills the body; it runs
post-commit.** A hook failure must never roll back or re-run a completed sync.

Outcome mapping (spec §6), implemented once in `outcomeForFailure` and pinned by a table test:

| executor / budget result | outcome | `next_sync_at` | Sentry |
|---|---|---|---|
| success, primary `ok`, not truncated | `success` | now + interval ± jitter | — |
| success, truncated | `partial` (no stale marking) | now + interval ± jitter | — |
| success, a secondary source not `ok` | `partial` | now + interval ± jitter | — |
| success, primary source `permission_missing` | `needs_consent` | **NULL** | — |
| success, primary source `unlicensed` | `success`, zero updates | now + interval ± jitter | — |
| `graph_permission_missing` | `needs_consent` | **NULL** | — |
| `continuation_invalid` | `partial-continue` (control flow only; `last_status` untouched) | **unchanged** — the row is still due, and the domain is re-claimed immediately | **no** |
| `sync_capacity`, `graph_throttled`, `read_rate_limited` | `throttled` | unchanged until the final attempt | — |
| `credential_unavailable`, `application_token_invalid` | `error` | **NULL** | **no** (Huntress rule) |
| every other `graph_*` / refusal / `executor_unavailable` | `error` | now + interval ± jitter | yes (Task 14 throws) |

**`continuation_invalid` is not an error.** The executor's continuation seal is
AES-GCM with a 1 h expiry and, when `M365_SYNC_CONTINUATION_KEY` is unset, an
ephemeral per-process key — so an executor restart mid-walk invalidates every
outstanding cursor. That is an expected, self-healing condition: clear
`m365_sync_state.continuation`, re-claim the same domain (which mints a fresh
generation so the abandoned attempt fences), and restart the walk. Recording it
as `error` would unschedule sign-in activity for a whole tenant every time the
executor was redeployed. W04 owns this mapping; W05 owns the sign-in persister
that actually produces continuations.

- [ ] **Step 1: Write the failing test** — `run.test.ts` (mock `./domains/*`, `../m365ControlPlane/readActionService`, `../../db`, and `./metrics`; keep `run.phaseA.test.ts` as the Phase A proof):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    loadContext: vi.fn(), assertFence: vi.fn(), release: vi.fn(),
    persistUsers: vi.fn(), callExecutor: vi.fn(),
    completion: [] as Record<string, unknown>[],
    audit: vi.fn(), metricRun: vi.fn(), metricFenced: vi.fn(), metricItems: vi.fn(),
    hook: vi.fn(),
    cadence: vi.fn((_d: string, st: { intervalSeconds: number }, _o: string, sig: { now: Date }) => ({
      intervalSeconds: st.intervalSeconds,
      nextSyncAt: new Date(sig.now.getTime() + st.intervalSeconds * 1000),
    })),
    claim: vi.fn(async () => []), enqueue: vi.fn(async () => 'job-1'),
    executorDepth: -1, depth: 0,
  },
}));

vi.mock('../../db', () => ({
  db: { update: () => ({ set: (payload: Record<string, unknown>) => ({ where: () => { mocks.completion.push(payload); return Promise.resolve(); } }) }) },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    mocks.depth += 1; try { return await fn(); } finally { mocks.depth -= 1; }
  }),
  runOutsideDbContext: vi.fn((fn: () => unknown) => {
    const saved = mocks.depth; mocks.depth = 0;
    try { return fn(); } finally { mocks.depth = saved; }
  }),
}));
vi.mock('./domains/users', () => ({ persistUsers: mocks.persistUsers }));
vi.mock('./metrics', () => ({
  recordM365SyncRun: mocks.metricRun, recordM365SyncFenced: mocks.metricFenced,
  recordM365SyncItems: mocks.metricItems, recordM365SyncExecutorSeconds: vi.fn(),
}));
vi.mock('./audit', () => ({ recordM365SyncRunEvent: mocks.audit }));
vi.mock('./hooks', () => ({ afterDomainPersisted: mocks.hook }));
vi.mock('./cadence', () => ({ applyCadence: mocks.cadence }));
vi.mock('./claim', () => ({ claimDueDomains: mocks.claim }));
vi.mock('../../jobs/m365SyncQueue', () => ({ enqueueSyncDomain: mocks.enqueue }));

import { outcomeForFailure, runSyncDomain } from './run';   // nextSyncAt lives in cadence.ts (Task 12) and is covered by cadence.test.ts

const JOB = { orgId: 'org-1', domain: 'users' as const, generation: 5, connectionId: 'conn-1',
  tenantId: 'tenant-1', consentGeneration: 2, priority: 10 as const };
const CTX = {
  snapshot: { id: 'conn-1', orgId: 'org-1', tenantId: 'tenant-1', consentGeneration: 2,
    status: 'active', permissionManifestVersion: 3, vaultRef: 'v', credentialVersion: 'c' },
  state: { intervalSeconds: 21600, continuation: null, lastCompleteSnapshotAt: null, lastSuccessAt: null },
  existing: new Map(),
};
const SYNC_OK = {
  ok: true, kind: 'sync', executorMs: 1200,
  result: { success: true, kind: 'sync', items: [{ id: 'u1' }], truncated: false,
    fetchedAt: '2026-09-08T00:00:00.000Z', sources: { users: 'ok', mfaRegistration: 'ok', roleAssignments: 'ok' } },
};
const PERSISTED = { inserted: 1, updated: 0, unchanged: 0, stale: 0, complete: true, counts: { users_total: 1, users_enabled: 1 } };

const run = (over: Record<string, unknown> = {}) =>
  runSyncDomain(JOB, { callExecutor: mocks.callExecutor, now: new Date('2026-09-08T00:00:00.000Z'), rng: () => 0.5, ...over });

describe('runSyncDomain', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.completion = []; mocks.depth = 0; mocks.executorDepth = -1;
    mocks.claim.mockResolvedValue([]); mocks.enqueue.mockResolvedValue('job-1');
    vi.doMock('./run', async (a) => a());
    mocks.loadContext.mockResolvedValue(CTX);
    mocks.assertFence.mockResolvedValue(null);
    mocks.persistUsers.mockResolvedValue(PERSISTED);
    mocks.callExecutor.mockImplementation(async () => { mocks.executorDepth = mocks.depth; return SYNC_OK; });
  });

  it('PHASE B holds NO db context while the executor call runs (#1105)', async () => {
    await run();
    expect(mocks.executorDepth).toBe(0);
  });

  it('routes the executor call through opts.route = sync and labels the histogram by DOMAIN', async () => {
    await run();
    expect(mocks.callExecutor.mock.calls[0]![2]).toMatchObject({ route: 'sync', domain: 'users' });
  });

  it('builds the action through m365SyncActionFor, passing the stored continuation and the backfill flag', async () => {
    await run();
    expect(mocks.callExecutor.mock.calls[0]![1]).toEqual({ type: 'm365.sync.users' });

    // last_success_at NULL means "never completed" -> backfill for secure_score.
    // Harmless for users (the builder drops the option), but the SAME call site
    // has to serve both, which is why it is asserted here rather than in W05.
    mocks.loadContext.mockResolvedValue({ ...CTX, state: { ...CTX.state, lastSuccessAt: new Date('2026-09-01T00:00:00.000Z') } });
    await run();
    expect(mocks.callExecutor.mock.calls[1]![1]).toEqual({ type: 'm365.sync.users' });
  });

  it('completes: success outcome, next_sync_at advanced, lease cleared, counts stored', async () => {
    await expect(run()).resolves.toBe('success');
    const completion = mocks.completion.at(-1)!;
    expect(completion).toMatchObject({ lastStatus: 'success', leaseUntil: null, truncated: false });
    expect(completion.nextSyncAt).toBeInstanceOf(Date);
    expect(completion.lastCounts).toEqual({ users_total: 1, users_enabled: 1 });
    expect(completion.lastCompleteSnapshotAt).toBeInstanceOf(Date);
  });

  it('a truncated run is partial, marks nothing stale, and does NOT stamp lastCompleteSnapshotAt', async () => {
    mocks.callExecutor.mockResolvedValue({ ...SYNC_OK, result: { ...SYNC_OK.result, truncated: true } });
    mocks.persistUsers.mockResolvedValue({ ...PERSISTED, complete: false, stale: 0 });
    await expect(run()).resolves.toBe('partial');
    const completion = mocks.completion.at(-1)!;
    expect(completion).toMatchObject({ lastStatus: 'partial', truncated: true });
    expect(completion.lastCompleteSnapshotAt).toBeUndefined();
  });

  it('a failed SECONDARY source is partial, not an error — the primary still persisted', async () => {
    mocks.callExecutor.mockResolvedValue({ ...SYNC_OK, result: { ...SYNC_OK.result,
      sources: { users: 'ok', mfaRegistration: 'permission_missing', roleAssignments: 'ok' } } });
    await expect(run()).resolves.toBe('partial');
    expect(mocks.persistUsers).toHaveBeenCalled();
  });

  it('a PRIMARY permission_missing is needs_consent and UNSCHEDULES the domain', async () => {
    mocks.callExecutor.mockResolvedValue({ ...SYNC_OK, result: { ...SYNC_OK.result, sources: { users: 'permission_missing' } } });
    await expect(run()).resolves.toBe('needs_consent');
    expect(mocks.completion.at(-1)).toMatchObject({ lastStatus: 'needs_consent', nextSyncAt: null, leaseUntil: null });
  });

  it('discards at the Phase C fence and writes NOTHING, incrementing the fenced metric', async () => {
    mocks.assertFence.mockResolvedValue('tenant_changed');
    await expect(run()).resolves.toBe('fenced');
    expect(mocks.persistUsers).not.toHaveBeenCalled();
    expect(mocks.completion).toEqual([]);
    expect(mocks.metricFenced).toHaveBeenCalledTimes(1);
  });

  it('fences BEFORE the fetch too, without spending a Graph call', async () => {
    mocks.loadContext.mockResolvedValue({ fenced: 'generation_mismatch' });
    await expect(run()).resolves.toBe('fenced');
    expect(mocks.callExecutor).not.toHaveBeenCalled();
  });

  it('a throttled result on a NON-final attempt writes no terminal state (BullMQ will retry)', async () => {
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'graph_throttled', message: 'm', retryAfterSeconds: 30, executorMs: 5 });
    await expect(run({ isFinalAttempt: false })).resolves.toBe('throttled');
    expect(mocks.completion).toEqual([]);
  });

  it('a throttled result on the FINAL attempt records throttled and re-schedules', async () => {
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'sync_capacity', message: 'm', retryAfterSeconds: 30, executorMs: 5 });
    await expect(run({ isFinalAttempt: true })).resolves.toBe('throttled');
    expect(mocks.completion.at(-1)).toMatchObject({ lastStatus: 'throttled', leaseUntil: null });
    expect(mocks.completion.at(-1)!.nextSyncAt).toBeInstanceOf(Date);
  });

  it('a connection auth failure unschedules and is NOT re-thrown (Huntress Sentry rule, spec §6)', async () => {
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'application_token_invalid', message: 'm', executorMs: 5 });
    await expect(run()).resolves.toBe('error');
    expect(mocks.completion.at(-1)).toMatchObject({ lastStatus: 'error', nextSyncAt: null });
  });

  it('records exactly ONE m365.sync.run audit event per run, with counts and no row content', async () => {
    await run();
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    const event = mocks.audit.mock.calls[0]![0];
    expect(event).toMatchObject({ orgId: 'org-1', connectionId: 'conn-1', domain: 'users',
      generation: 5, outcome: 'success', inserted: 1, truncated: false });
    expect(JSON.stringify(event)).not.toContain('u1');
  });

  it('writes NO audit event when it fenced (nothing happened)', async () => {
    mocks.assertFence.mockResolvedValue('consent_changed');
    await run();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('calls applyCadence with the domain first and ALL SIX signals populated', async () => {
    await run();
    expect(mocks.cadence).toHaveBeenCalledWith(
      'users', { intervalSeconds: 21600 }, 'success',
      {
        truncated: false, latencyMs: 1200, capacity: false,
        unlicensed: false, authFailure: false, now: new Date('2026-09-08T00:00:00.000Z'),
      },
      expect.any(Function),
    );
  });

  it('stores the {intervalSeconds, nextSyncAt} PAIR applyCadence returned, computing neither itself', async () => {
    mocks.cadence.mockReturnValue({ intervalSeconds: 999, nextSyncAt: new Date('2027-01-01T00:00:00.000Z') });
    await run();
    expect(mocks.completion.at(-1)).toMatchObject({
      intervalSeconds: 999,
      nextSyncAt: new Date('2027-01-01T00:00:00.000Z'),
    });
  });

  it('marks unlicensed from sources.signInActivity, and authFailure only for a DEAD CREDENTIAL', async () => {
    mocks.callExecutor.mockResolvedValue({ ...SYNC_OK, result: { ...SYNC_OK.result,
      sources: { users: 'ok', signInActivity: 'unlicensed' } } });
    await run();
    expect(mocks.cadence.mock.calls[0]![3]).toMatchObject({ unlicensed: true, authFailure: false });

    mocks.cadence.mockClear();
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'application_token_invalid', message: 'm', executorMs: 5 });
    await run();
    expect(mocks.cadence.mock.calls[0]![3]).toMatchObject({ authFailure: true });

    // graph_permission_missing is needs_consent, NOT a dead credential — if it
    // fed authFailure, W05's cadence would back off a tenant that simply needs
    // a re-consent click.
    mocks.cadence.mockClear();
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'graph_permission_missing', message: 'm', executorMs: 5 });
    await run();
    expect(mocks.cadence.mock.calls[0]![3]).toMatchObject({ authFailure: false });
  });

  it('calls afterDomainPersisted AFTER the completion commit, with the full persist context', async () => {
    const order: string[] = [];
    mocks.hook.mockImplementation(async () => { order.push('hook'); });
    mocks.persistUsers.mockImplementation(async () => { order.push('persist'); return PERSISTED; });
    await run();
    expect(order).toEqual(['persist', 'hook']);
    expect(mocks.completion).toHaveLength(1);           // the commit happened first
    expect(mocks.hook).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1', tenantId: 'tenant-1', connectionId: 'conn-1', generation: 5,
      domain: 'users', outcome: 'success', persisted: PERSISTED,
    }));
  });

  it('a THROWING hook is logged and swallowed — a completed sync is never rolled back or re-run', async () => {
    mocks.hook.mockRejectedValue(new Error('rollup exploded'));
    await expect(run()).resolves.toBe('success');
    expect(mocks.completion).toHaveLength(1);
  });

  it('continuation_invalid CLEARS the cursor, re-claims the domain, and returns partial-continue', async () => {
    mocks.loadContext.mockResolvedValue({ ...CTX, state: { ...CTX.state, continuation: 'stale-cursor' } });
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'continuation_invalid', message: 'm', executorMs: 5 });
    mocks.claim.mockResolvedValue([{ ...JOB, generation: 6 }]);

    await expect(run()).resolves.toBe('partial-continue');

    // continuation-only write: cursor cleared, lease released, and NOTHING that
    // would make a half-finished walk look like a finished run.
    const completion = mocks.completion.at(-1)!;
    expect(completion).toMatchObject({ continuation: null, leaseUntil: null });
    expect(completion).not.toHaveProperty('lastStatus');
    expect(completion).not.toHaveProperty('nextSyncAt');
    expect(completion).not.toHaveProperty('lastCounts');

    // Re-claimed on the SAME domain at the normal lane, then enqueued, so the
    // restarted run gets a fresh generation and the abandoned one fences.
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', domains: ['users'], priority: 10 }),
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ domain: 'users', generation: 6 }));
  });

  it('continuation_invalid writes NO audit event and NO run metric — the run has not finished', async () => {
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'continuation_invalid', message: 'm', executorMs: 5 });
    await run();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.metricRun).not.toHaveBeenCalled();
  });

  it('a failed re-claim after continuation_invalid is survivable: still partial-continue, cursor still cleared', async () => {
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'continuation_invalid', message: 'm', executorMs: 5 });
    mocks.claim.mockRejectedValue(new Error('redis blip'));
    // The row keeps its past next_sync_at, so the next tick reclaims it anyway.
    await expect(run()).resolves.toBe('partial-continue');
    expect(mocks.completion.at(-1)).toMatchObject({ continuation: null });
  });

  it('emits exactly ONE structured log line per completed run, carrying counts and no row content', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args.join(' ')); });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    const lines = logged.filter((line) => line.includes('m365.sync.run'));
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!.slice(lines[0]!.indexOf('{')));
    expect(payload).toMatchObject({
      orgId: 'org-1', domain: 'users', connectionId: 'conn-1', generation: 5,
      outcome: 'success', inserted: 1, updated: 0, stale: 0, unchanged: 0, truncated: false,
    });
    expect(payload.correlationId).toEqual(expect.any(String));
    expect(JSON.stringify(payload)).not.toContain('u1');
  });

  it('is a no-op that unschedules a domain with no persister, so it cannot spin every tick', async () => {
    await expect(runSyncDomain({ ...JOB, domain: 'secure_score' }, { callExecutor: mocks.callExecutor }))
      .resolves.toBe('noop');
    expect(mocks.callExecutor).not.toHaveBeenCalled();
    expect(mocks.completion.at(-1)).toMatchObject({ nextSyncAt: null, leaseUntil: null });
  });

  it('publishes run and item metrics by domain', async () => {
    mocks.persistUsers.mockResolvedValue({ ...PERSISTED, inserted: 2, updated: 3, stale: 1, unchanged: 4 });
    await run();
    expect(mocks.metricRun).toHaveBeenCalledWith('users', 'success');
    expect(mocks.metricItems).toHaveBeenCalledWith('users', 'insert', 2);
    expect(mocks.metricItems).toHaveBeenCalledWith('users', 'update', 3);
    expect(mocks.metricItems).toHaveBeenCalledWith('users', 'stale', 1);
    expect(mocks.metricItems).toHaveBeenCalledWith('users', 'unchanged', 4);
  });
});

describe('outcomeForFailure (spec §6)', () => {
  it.each([
    ['graph_permission_missing', 'needs_consent', true, false, false],
    ['sync_capacity', 'throttled', false, false, false],
    ['graph_throttled', 'throttled', false, false, false],
    ['read_rate_limited', 'throttled', false, false, false],
    ['credential_unavailable', 'error', true, false, false],
    ['application_token_invalid', 'error', true, false, false],
    ['continuation_invalid', 'partial', false, false, true],
    ['graph_transport_failed', 'error', false, true, false],
    ['executor_unavailable', 'error', false, true, false],
    ['graph_response_invalid', 'error', false, true, false],
    ['connection_not_ready', 'error', false, true, false],
  ])('%s -> %s (unschedule=%s, sentry=%s, restartWalk=%s)', (code, outcome, unschedule, sentryWorthy, restartWalk) => {
    expect(outcomeForFailure(code as never)).toEqual({ outcome, unschedule, sentryWorthy, restartWalk });
  });

  it('never reports a dead credential OR an expired cursor to Sentry', () => {
    for (const code of ['credential_unavailable', 'application_token_invalid', 'continuation_invalid'] as const) {
      expect(outcomeForFailure(code).sentryWorthy).toBe(false);
    }
  });
});
```

> `loadSyncRunContext` / `assertStillFenced` / `releaseLease` live in the same module as `runSyncDomain`, so mock them with `vi.spyOn` on the imported module namespace, or extract them behind an injectable `deps` object — pick one and keep it consistent. The simplest that keeps the production call sites clean: give `runSyncDomain` a private `deps` default `{ loadSyncRunContext, assertStillFenced, releaseLease }` on `opts`, and have the test pass `mocks`.

- [ ] **Step 2: Run — must FAIL**

```bash
cd apps/api && npx vitest run src/services/m365Sync/run.test.ts
```

- [ ] **Step 3: Implement**

`apps/api/src/services/m365Sync/audit.ts`:

```ts
import type { M365SyncDomain } from '@breeze/shared/m365';
import { requestLikeFromSnapshot, writeAuditEvent } from '../auditEvents';
import type { M365SyncRunResult } from './types';

/**
 * One audit event per sync-domain run (spec §7). Details are a fixed allowlist
 * of SHAPE and OUTCOME metadata — never a Graph item, a UPN, a device name, or
 * an error string that could carry row content (spec §8: `last_error` is a
 * sanitized code, and this event carries even less).
 *
 * Fire-and-forget: writeAuditEvent opens its own runOutsideDbContext + system
 * context, so this is safe to call immediately after the completion
 * transaction commits and can never roll it back.
 */
export function recordM365SyncRunEvent(input: {
  orgId: string;
  connectionId: string;
  domain: M365SyncDomain;
  generation: number;
  outcome: M365SyncRunResult;
  correlationId: string;
  truncated: boolean;
  inserted: number;
  updated: number;
  stale: number;
  unchanged: number;
}): void {
  writeAuditEvent(requestLikeFromSnapshot({}), {
    orgId: input.orgId,
    action: 'm365.sync.run',
    resourceType: 'm365_connection',
    resourceId: input.connectionId,
    details: {
      domain: input.domain,
      generation: input.generation,
      outcome: input.outcome,
      truncated: input.truncated,
      inserted: input.inserted,
      updated: input.updated,
      stale: input.stale,
      unchanged: input.unchanged,
      correlationId: input.correlationId,
    },
    result: input.outcome === 'success' || input.outcome === 'partial' ? 'success' : 'failure',
    actorType: 'system',
  });
}
```

Append to `apps/api/src/services/m365Sync/run.ts`:

> **On the logger.** There is no `createLogger`/pino module in `apps/api` —
> `grep -rn 'createLogger\|pino\|logger' apps/api/src/services/m365ControlPlane/*.ts`
> returns nothing. The repo's structured-logging convention is a tagged
> `console.*` plus one `JSON.stringify(fields)` argument (see
> `apps/api/src/jobs/dnsSyncJob.ts:123-146`). This wave follows it through a
> single module-local `logSync` helper so the run line, the hook-failure line
> and the ticker lines all share one shape and one tag — and so that swapping in
> a real logger later is one function body, not a grep.

```ts
import { randomUUID } from 'node:crypto';
import { M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS } from '@breeze/shared/m365';
import { runOutsideDbContext } from '../../db';
import { enqueueSyncDomain } from '../../jobs/m365SyncQueue';
import {
  callGraphReadExecutor, type M365SyncCallFailureCode, type M365SyncCallResult,
} from '../m365ControlPlane/readActionService';
import { redactLogMessage } from '../logRedaction';
import { recordM365SyncRunEvent } from './audit';
import { applyCadence } from './cadence';
import { claimDueDomains } from './claim';
import { afterDomainPersisted } from './hooks';
import { persistCaPolicies } from './domains/caPolicies';
import { persistIntuneDevices } from './domains/intuneDevices';
import { persistSkus } from './domains/skus';
import { persistUsers } from './domains/users';
import {
  recordM365SyncFenced, recordM365SyncItems, recordM365SyncRun,
} from './metrics';
import {
  M365_SYNC_PRIMARY_SOURCE_KEY, m365SyncActionFor,
  type CadenceSignals, type DomainPersistResult, type M365DomainPersister,
  type M365SyncOutcome, type M365SyncRunResult, type PersistContext,
} from './types';

/**
 * Every domain, four with a persister and two explicitly `undefined`. A TOTAL
 * Record rather than a Partial on purpose: when W05 registers
 * `persistSigninActivity` and `persistSecureScore` it edits two `undefined`s
 * into two functions, and a domain added to `M365SyncDomain` later is a compile
 * error here instead of a silent `noop` in production.
 */
export const DOMAIN_PERSISTERS: Record<M365SyncDomain, M365DomainPersister | undefined> = {
  users: persistUsers,
  intune_devices: persistIntuneDevices,
  ca_policies: persistCaPolicies,
  skus: persistSkus,
  signin_activity: undefined,   // W05
  secure_score: undefined,      // W05
};

/**
 * The one structured log call for this service. Tagged + JSON payload, matching
 * jobs/dnsSyncJob.ts:123-146 — there is no logger module in apps/api. Messages
 * are run through redactLogMessage because an executor error string is the one
 * field here that did not originate in our own code.
 */
export function logSync(event: string, fields: Record<string, unknown>): void {
  console.log(`[M365Sync] ${event}`, JSON.stringify(fields));
}

/** Codes that mean the CREDENTIAL is dead, for `CadenceSignals.authFailure`. */
const AUTH_FAILURE_CODES = new Set<M365SyncCallFailureCode>([
  'credential_unavailable',
  'application_token_invalid',
  // NOT graph_permission_missing: that is a missing GRANT, answered by a
  // re-consent click, and treating it as a dead credential would have W05's
  // cadence back off a tenant that is one button away from working.
]);

/**
 * Spec §6, in one place. `unschedule` sets next_sync_at NULL (the domain waits
 * for a re-consent or a retest to re-seed it); `sentryWorthy` tells the worker
 * whether to throw, because a dead credential is a config issue already
 * recorded on the row and capturing it once per scheduled run is exactly what
 * flooded the Sentry quota for Huntress (BREEZE-1); `restartWalk` means the
 * page cursor is gone and the walk must be restarted from the beginning.
 */
export function outcomeForFailure(code: M365SyncCallFailureCode): {
  outcome: M365SyncOutcome; unschedule: boolean; sentryWorthy: boolean; restartWalk: boolean;
} {
  switch (code) {
    case 'graph_permission_missing':
      return { outcome: 'needs_consent', unschedule: true, sentryWorthy: false, restartWalk: false };
    case 'sync_capacity':
    case 'graph_throttled':
    case 'read_rate_limited':
      return { outcome: 'throttled', unschedule: false, sentryWorthy: false, restartWalk: false };
    case 'credential_unavailable':
    case 'application_token_invalid':
      return { outcome: 'error', unschedule: true, sentryWorthy: false, restartWalk: false };
    case 'continuation_invalid':
      // Expected and self-healing: the executor's continuation seal expires
      // after an hour and dies outright on an executor restart when
      // M365_SYNC_CONTINUATION_KEY is unset. Recording it as `error` would
      // unschedule a tenant's sign-in activity every time we redeployed.
      // `outcome` is unused on this branch — the run returns 'partial-continue'
      // and writes no last_status at all.
      return { outcome: 'partial', unschedule: false, sentryWorthy: false, restartWalk: true };
    default:
      return { outcome: 'error', unschedule: false, sentryWorthy: true, restartWalk: false };
  }
}

/** Sanitized, bounded error text for `last_error`. Never row content (spec §3.1). */
function sanitizedError(code: string, message: string): string {
  return `${code}: ${redactLogMessage(message)}`.slice(0, 500);
}

interface WriteCompletionContext {
  data: M365SyncJobData;
  now: Date;
  correlationId: string;
}

type CompletionArgs =
  | {
      mode: 'complete';
      outcome: M365SyncOutcome;
      persisted: DomainPersistResult;
      /** Both halves come from applyCadence; run.ts computes neither. */
      cadence: { intervalSeconds: number; nextSyncAt: Date | null };
      itemCount: number;
      truncated: boolean;
      sources: Record<string, string> | null;
      continuation: string | null;
      lastError: string | null;
    }
  | { mode: 'continuation'; continuation: string | null };

/** A persist that did not happen, for the failure branches. */
const NO_PERSIST: DomainPersistResult = {
  inserted: 0, updated: 0, stale: 0, unchanged: 0, counts: {}, complete: false,
};

/**
 * The SINGLE completion writer — nothing else updates m365_sync_state on the
 * completion path, which is what keeps "one run, one state write, one audit
 * event, one log line" true by construction.
 *
 * Guarded on run_generation as a SECOND fence beyond the Phase C FOR UPDATE
 * re-read: between that read and this write the transaction is open, so this is
 * belt-and-braces, and it costs one predicate.
 *
 * `mode: 'continuation'` exists for the 'partial-continue' restart. It stores
 * the cursor and releases the lease and NOTHING else: touching next_sync_at,
 * last_status or last_counts there would make a half-finished walk look like a
 * finished run to the card, the rollup and the operator.
 */
async function writeCompletion(ctx: WriteCompletionContext, args: CompletionArgs): Promise<void> {
  const { data, now } = ctx;
  const set = args.mode === 'continuation'
    ? { continuation: args.continuation, leaseUntil: null, updatedAt: now }
    : {
      lastRunAt: now,
      lastStatus: args.outcome,
      ...(args.outcome === 'success' || args.outcome === 'partial' ? { lastSuccessAt: now } : {}),
      ...(args.persisted.complete ? { lastCompleteSnapshotAt: now } : {}),
      lastError: args.lastError,
      lastItemCount: args.itemCount,
      truncated: args.truncated,
      ...(args.sources ? { sources: args.sources } : {}),
      ...(Object.keys(args.persisted.counts).length ? { lastCounts: args.persisted.counts } : {}),
      continuation: args.continuation,
      intervalSeconds: args.cadence.intervalSeconds,
      nextSyncAt: args.cadence.nextSyncAt,
      leaseUntil: null,
      updatedAt: now,
    };

  await withSystemDbAccessContext(async () => {
    await db.update(m365SyncState)
      .set(set)
      .where(and(
        eq(m365SyncState.orgId, data.orgId),
        eq(m365SyncState.domain, data.domain),
        eq(m365SyncState.runGeneration, data.generation),
      ));
  }, 'm365SyncCompletion');

  if (args.mode === 'complete') {
    // ONE line per run. Everything an operator needs to explain a run without
    // opening the database, and nothing that could carry a UPN or a device name.
    logSync('m365.sync.run', {
      orgId: data.orgId,
      domain: data.domain,
      connectionId: data.connectionId,
      generation: data.generation,
      correlationId: ctx.correlationId,
      outcome: args.outcome,
      inserted: args.persisted.inserted,
      updated: args.persisted.updated,
      stale: args.persisted.stale,
      unchanged: args.persisted.unchanged,
      truncated: args.truncated,
    });
  }
}

/**
 * Post-commit seam call (spec §5.6/§5.9, filled by W05). Runs OUTSIDE any DB
 * context — the hook opens its own — and a throw here is logged and swallowed:
 * the sync is already committed, and rolling it back or re-running it because a
 * rollup failed would turn a cosmetic failure into a re-fetch of the whole
 * tenant.
 */
async function runAfterDomainPersisted(
  ctx: PersistContext,
  domain: M365SyncDomain,
  outcome: M365SyncOutcome,
  persisted: DomainPersistResult,
): Promise<void> {
  try {
    await afterDomainPersisted({ ...ctx, domain, outcome, persisted });
  } catch (error) {
    logSync('hook-failed', {
      orgId: ctx.orgId,
      domain,
      generation: ctx.generation,
      error: redactLogMessage(error instanceof Error ? error.message : String(error)),
    });
  }
}

/**
 * One `sync-domain` run, three phases (spec §5.3).
 *
 * The WHOLE body runs inside runOutsideDbContext so every phase opens its own
 * fresh system context and Phase B genuinely holds none — the same shape
 * services/auditService.ts uses, and the reason a "by-org" helper that did its
 * own lookup under ambient context could not be used here at all.
 *
 * Nothing in here throws for an expected condition. The worker decides what to
 * re-raise (Task 14): a throttle on a non-final attempt becomes a retryable
 * error there, and a dead credential becomes nothing at all.
 */
export async function runSyncDomain(
  data: M365SyncJobData,
  opts: {
    isFinalAttempt?: boolean;
    now?: Date;
    rng?: () => number;
    callExecutor?: typeof callGraphReadExecutor;
  } = {},
): Promise<M365SyncRunResult> {
  const now = opts.now ?? new Date();
  const rng = opts.rng;
  const callExecutor = opts.callExecutor ?? callGraphReadExecutor;
  const correlationId = randomUUID();
  const persister = DOMAIN_PERSISTERS[data.domain];
  const completionCtx = { data, now, correlationId };

  return runOutsideDbContext(async () => {
    // A domain with no persister must be UNSCHEDULED, not merely skipped: a
    // skipped row keeps its past next_sync_at and would be re-claimed every
    // tick forever, burning ticker slots against the §5.9 capacity budget.
    if (!persister) {
      await writeCompletion(completionCtx, {
        mode: 'complete', outcome: 'error', persisted: NO_PERSIST,
        // next_sync_at NULL unschedules it; interval_seconds keeps the domain's
        // DEFAULT rather than 0, so when W05 registers the persister and
        // re-seeds, the row already carries a sane cadence instead of a zero
        // that would make the first completion schedule it for `now`.
        cadence: {
          intervalSeconds: M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS[data.domain],
          nextSyncAt: null,
        },
        itemCount: 0, truncated: false, sources: null, continuation: null,
        lastError: sanitizedError('domain_not_implemented', `no persister for ${data.domain}`),
      });
      return 'noop';
    }

    // ---- Phase A ----------------------------------------------------------
    const loaded = await loadSyncRunContext(data);
    if ('fenced' in loaded) {
      recordM365SyncFenced();
      await releaseLease(data);
      return 'fenced';
    }

    const persistCtx: PersistContext = {
      orgId: data.orgId, tenantId: data.tenantId, connectionId: data.connectionId,
      generation: data.generation, existing: loaded.existing, now,
    };

    // ---- Phase B: NO DB context held --------------------------------------
    // ONE action builder, always given both options. `backfill` is true only
    // when this domain has never completed for this org, which is exactly what
    // secure_score's initial 90-day pull needs; the builder drops the option
    // for the domains whose action does not accept it.
    const call = await callExecutor(
      loaded.snapshot,
      m365SyncActionFor(data.domain, {
        continuation: loaded.state.continuation,
        backfill: loaded.state.lastSuccessAt === null,
      }),
      { route: 'sync', correlationId, domain: data.domain },
    ) as M365SyncCallResult;

    // ---- Phase C ----------------------------------------------------------
    const fenced = await assertStillFenced(data);
    if (fenced) {
      recordM365SyncFenced();
      return 'fenced';
    }

    /** Six always-populated signals for the cadence seam (spec §5.7). */
    const signalsFor = (over: Partial<CadenceSignals>): CadenceSignals => ({
      truncated: false,
      latencyMs: call.executorMs,
      capacity: false,
      unlicensed: false,
      authFailure: false,
      now,
      ...over,
    });

    if (!call.ok) {
      const { outcome, unschedule, restartWalk } = outcomeForFailure(call.code);

      // The continuation seal expired or died with an executor restart. Clear
      // the cursor, leave every completion field alone (the walk did NOT
      // finish), and re-claim the same domain so the restart runs under a fresh
      // generation — which is also what fences the attempt we are abandoning.
      if (restartWalk) {
        await writeCompletion(completionCtx, { mode: 'continuation', continuation: null });
        try {
          const reclaimed = await claimDueDomains({
            limit: 1, orgId: data.orgId, domains: [data.domain], priority: 10,
          });
          for (const job of reclaimed) await enqueueSyncDomain(job);
        } catch (error) {
          // Survivable: next_sync_at was never advanced, so the row is still
          // due and the next 60 s tick reclaims it.
          logSync('continuation-restart-failed', {
            orgId: data.orgId, domain: data.domain, generation: data.generation,
            error: redactLogMessage(error instanceof Error ? error.message : String(error)),
          });
        }
        return 'partial-continue';
      }

      // A throttle mid-retry writes nothing: the lease is still ours (20 min vs
      // a 10.5-minute retry ladder) and BullMQ will bring the job back.
      if (outcome === 'throttled' && !opts.isFinalAttempt) return 'throttled';

      const cadence = applyCadence(
        data.domain, { intervalSeconds: loaded.state.intervalSeconds }, outcome,
        signalsFor({
          capacity: call.code === 'sync_capacity',
          authFailure: AUTH_FAILURE_CODES.has(call.code),
        }),
        rng,
      );
      await writeCompletion(completionCtx, {
        mode: 'complete', outcome, persisted: NO_PERSIST,
        cadence: unschedule ? { intervalSeconds: cadence.intervalSeconds, nextSyncAt: null } : cadence,
        itemCount: 0, truncated: false, sources: null,
        continuation: loaded.state.continuation,
        lastError: sanitizedError(call.code, call.message),
      });
      recordM365SyncRun(data.domain, outcome);
      recordM365SyncRunEvent({
        orgId: data.orgId, connectionId: data.connectionId, domain: data.domain,
        generation: data.generation, outcome, correlationId, truncated: false,
        inserted: 0, updated: 0, stale: 0, unchanged: 0,
      });
      await runAfterDomainPersisted(persistCtx, data.domain, outcome, NO_PERSIST);
      return outcome;
    }

    const result = call.result;
    const primaryKey = M365_SYNC_PRIMARY_SOURCE_KEY[data.domain];
    const primaryState = result.sources[primaryKey];
    const unlicensed = result.sources.signInActivity === 'unlicensed';

    // A primary source that is not granted is needs_consent even on a 200 —
    // the executor reports it as a `sources` entry, not an error code.
    if (primaryState === 'permission_missing') {
      const cadence = applyCadence(
        data.domain, { intervalSeconds: loaded.state.intervalSeconds }, 'needs_consent',
        signalsFor({ truncated: result.truncated, unlicensed }), rng,
      );
      await writeCompletion(completionCtx, {
        mode: 'complete', outcome: 'needs_consent', persisted: NO_PERSIST,
        cadence: { intervalSeconds: cadence.intervalSeconds, nextSyncAt: null },
        itemCount: 0, truncated: result.truncated, sources: result.sources,
        continuation: result.continuation ?? null,
        lastError: sanitizedError('graph_permission_missing', `primary source ${primaryKey} not granted`),
      });
      recordM365SyncRun(data.domain, 'needs_consent');
      recordM365SyncRunEvent({
        orgId: data.orgId, connectionId: data.connectionId, domain: data.domain,
        generation: data.generation, outcome: 'needs_consent', correlationId,
        truncated: result.truncated, inserted: 0, updated: 0, stale: 0, unchanged: 0,
      });
      await runAfterDomainPersisted(persistCtx, data.domain, 'needs_consent', NO_PERSIST);
      return 'needs_consent';
    }

    const persisted: DomainPersistResult = await persister(persistCtx, result);

    // partial when anything was less than whole: truncated, or ANY source not ok.
    const allSourcesOk = Object.values(result.sources).every((state) => state === 'ok' || state === 'unlicensed');
    const outcome: M365SyncOutcome = persisted.complete && allSourcesOk ? 'success' : 'partial';
    const cadence = applyCadence(
      data.domain, { intervalSeconds: loaded.state.intervalSeconds }, outcome,
      signalsFor({ truncated: result.truncated, unlicensed }), rng,
    );

    await writeCompletion(completionCtx, {
      mode: 'complete', outcome, persisted, cadence,
      itemCount: result.items.length, truncated: result.truncated,
      sources: result.sources, continuation: result.continuation ?? null, lastError: null,
    });

    recordM365SyncRun(data.domain, outcome);
    recordM365SyncItems(data.domain, 'insert', persisted.inserted);
    recordM365SyncItems(data.domain, 'update', persisted.updated);
    recordM365SyncItems(data.domain, 'stale', persisted.stale);
    recordM365SyncItems(data.domain, 'unchanged', persisted.unchanged);
    recordM365SyncRunEvent({
      orgId: data.orgId, connectionId: data.connectionId, domain: data.domain,
      generation: data.generation, outcome, correlationId, truncated: result.truncated,
      inserted: persisted.inserted, updated: persisted.updated,
      stale: persisted.stale, unchanged: persisted.unchanged,
    });
    // AFTER the completion commit, outside any DB context. W05 fills the body.
    await runAfterDomainPersisted(persistCtx, data.domain, outcome, persisted);
    return outcome;
  });
}
```

- [ ] **Step 4: Run — must PASS** (both run suites and every domain suite)

```bash
cd apps/api && npx vitest run src/services/m365Sync
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/run.ts apps/api/src/services/m365Sync/run.test.ts apps/api/src/services/m365Sync/audit.ts
git commit -m "$(cat <<'EOF'
feat(m365): add the three-phase sync-domain runner

Phase B holds no DB context (the whole body runs inside runOutsideDbContext,
each phase opening its own system context); Phase C re-reads FOR UPDATE and
discards on any of the four fencing conditions, counting m365_sync_fenced.

Outcome mapping lives in one outcomeForFailure() pinned by a table test
(spec §6): a primary permission_missing unschedules, a throttle mid-retry
writes nothing at all, a dead credential unschedules WITHOUT throwing so it
never reaches Sentry (the Huntress BREEZE-1 rule), and continuation_invalid
clears the cursor and re-claims the domain instead of unscheduling a tenant's
sign-in activity every time the executor is redeployed.

writeCompletion is the single completion writer, with a continuation-only mode
for that restart so a half-finished walk never looks finished. It takes the
{intervalSeconds, nextSyncAt} pair from applyCadence — run.ts computes no due
time itself — and emits ONE structured log line per run. afterDomainPersisted
runs post-commit, outside any context, and a throw there is logged, never
rethrown: a rollup failure must not re-fetch a whole tenant.

One m365.sync.run audit event per run carries shape and outcome only, never
row content.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 14: `jobs/m365SyncWorker.ts` — ticker, processor, backoff, failure classification

Spec §5.2 (ticker), §5.3 (concurrency), §5.9 (utilisation), §6, §10 step 1.

**Files:**
- Create: `apps/api/src/jobs/m365SyncWorker.ts`
- Create: `apps/api/src/jobs/m365SyncWorker.test.ts`
- Edit: `apps/api/src/jobs/workerObservability.ts` (one entry in `WORKER_FAILURE_REASONS`)

**Interfaces:**
- Consumes: Task 7 queue/backoff, Task 6/7 claim, Task 13 `runSyncDomain`, Task 5 metrics, Task 1 flag + knobs.
- Produces (used by Task 15):

```ts
export const M365_SYNC_WORKER_NAME = 'm365SyncWorker';
export class M365SyncRetryableError extends Error {}
export interface M365SyncTickResult { claimed: number; depth: number; seeded: number; due: number; skipped?: 'flag_off' | 'backpressure' }
export async function runM365SyncTick(now?: Date): Promise<M365SyncTickResult>;
export function classifyM365SyncFailure(job: Job | undefined, err: Error): WorkerFailureClassification | null;
export async function initializeM365SyncWorker(): Promise<void>;
export async function shutdownM365SyncWorker(): Promise<void>;
```

> **No `scheduleRegistry.ts` slot.** That registry allocates coarse (>= hourly) repeatable schedules; a 60 s tick is explicitly exempt ("a 60-second tick has to fire every 60 seconds, and re-anchoring it buys nothing"). W02's daily `m365-sync-retention` job is the one that needs a slot, and it is W02's.

- [ ] **Step 1: Write the failing test** — `jobs/m365SyncWorker.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    counts: vi.fn(), add: vi.fn(async () => ({ id: 'j' })), getRepeatables: vi.fn(async () => [] as unknown[]),
    removeRepeatable: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => 0), claim: vi.fn(async () => []), countDue: vi.fn(async () => 0),
    enqueue: vi.fn(async () => 'job-1'), run: vi.fn(async () => 'success'),
    metricDepth: vi.fn(), metricUtil: vi.fn(), metricSkipped: vi.fn(), metricBacklog: vi.fn(),
    order: [] as string[],
  },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJobCounts = mocks.counts; add = mocks.add;
    getRepeatableJobs = mocks.getRepeatables; removeRepeatableByKey = mocks.removeRepeatable;
    getJob = vi.fn(async () => null); close = vi.fn();
  },
  Worker: class { on = vi.fn(); close = vi.fn(); },
  Job: class {},
  UnrecoverableError: class UnrecoverableError extends Error {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/m365Sync/claim', () => ({
  reconcileEligibleConnections: mocks.reconcile, claimDueDomains: mocks.claim,
  countDueDomains: mocks.countDue, syncJobId: (d: { orgId: string; domain: string; generation: number }) =>
    `m365-sync-${d.orgId}-${d.domain}-${d.generation}`,
}));
vi.mock('./m365SyncQueue', async (actual) => ({
  ...(await actual<typeof import('./m365SyncQueue')>()),
  enqueueSyncDomain: mocks.enqueue,
}));
vi.mock('../services/m365Sync/run', () => ({ runSyncDomain: mocks.run, logSync: vi.fn() }));
vi.mock('../services/m365Sync/metrics', () => ({
  setM365SyncQueueDepth: mocks.metricDepth, setM365SyncTickerUtilisation: mocks.metricUtil,
  recordM365SyncTickerSkipped: mocks.metricSkipped, setM365SyncDueBacklog: mocks.metricBacklog,
}));

import { classifyM365SyncFailure, M365SyncRetryableError, runM365SyncTick } from './m365SyncWorker';

const CLAIMED = {
  orgId: 'org-1', domain: 'users' as const, generation: 3, connectionId: 'conn-1',
  tenantId: 'tenant-1', consentGeneration: 1, priority: 10 as const,
};

describe('runM365SyncTick (spec §5.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.M365_SYNC_MAX_BACKLOG;
    delete process.env.M365_SYNC_TICK_BATCH;
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    mocks.counts.mockResolvedValue({ waiting: 0, prioritized: 0, delayed: 0, active: 0 });
  });

  it('does nothing at all when the flag is off', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'false';
    await expect(runM365SyncTick()).resolves.toMatchObject({ skipped: 'flag_off', claimed: 0 });
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('counts prioritized AND delayed in the backpressure depth, not just waiting+active', async () => {
    process.env.M365_SYNC_MAX_BACKLOG = '10';
    mocks.counts.mockResolvedValue({ waiting: 3, prioritized: 4, delayed: 4, active: 1 });
    const result = await runM365SyncTick();
    expect(result.depth).toBe(12);
    expect(result.skipped).toBe('backpressure');
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.metricSkipped).toHaveBeenCalledTimes(1);
  });

  it('publishes the queue-depth gauge even on the skipped path', async () => {
    process.env.M365_SYNC_MAX_BACKLOG = '1';
    mocks.counts.mockResolvedValue({ waiting: 9, prioritized: 0, delayed: 0, active: 0 });
    await runM365SyncTick();
    expect(mocks.metricDepth).toHaveBeenCalledWith(9);
  });

  it('reconciles BEFORE claiming, so a newly-consented org is claimable in the same tick', async () => {
    mocks.reconcile.mockImplementation(async () => { mocks.order.push('reconcile'); return 2; });
    mocks.claim.mockImplementation(async () => { mocks.order.push('claim'); return []; });
    mocks.order.length = 0;
    await runM365SyncTick();
    expect(mocks.order).toEqual(['reconcile', 'claim']);
  });

  it('claims the configured batch and enqueues one job per claimed row', async () => {
    process.env.M365_SYNC_TICK_BATCH = '50';
    mocks.claim.mockResolvedValue([CLAIMED, { ...CLAIMED, domain: 'skus' as const }]);
    const result = await runM365SyncTick();
    expect(mocks.claim).toHaveBeenCalledWith({ limit: 50 });
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(result.claimed).toBe(2);
  });

  it('publishes utilisation as claimed/batch (the §5.9 <= 50% target)', async () => {
    process.env.M365_SYNC_TICK_BATCH = '4';
    mocks.claim.mockResolvedValue([CLAIMED, CLAIMED]);
    await runM365SyncTick();
    expect(mocks.metricUtil).toHaveBeenCalledWith(0.5);
  });

  it('publishes the due-backlog gauge from the state table, not from the queue', async () => {
    mocks.countDue.mockResolvedValue(37);
    await expect(runM365SyncTick()).resolves.toMatchObject({ due: 37 });
    expect(mocks.metricBacklog).toHaveBeenCalledWith(37);
  });

  it('never enqueues a job id containing a colon', async () => {
    mocks.claim.mockResolvedValue([CLAIMED]);
    await runM365SyncTick();
    expect(JSON.stringify(mocks.enqueue.mock.calls[0]![0])).not.toContain(':');
  });

  it('does not abandon the remaining claims when ONE enqueue fails', async () => {
    mocks.claim.mockResolvedValue([CLAIMED, { ...CLAIMED, domain: 'skus' as const }]);
    mocks.enqueue.mockRejectedValueOnce(new Error('redis blip'));
    const result = await runM365SyncTick();
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    // The failed row keeps its past next_sync_at and its lease expires in 20
    // minutes, so the next tick reclaims it (spec §5.2 "Recovery").
    expect(result.claimed).toBe(2);
  });
});

describe('classifyM365SyncFailure', () => {
  it('classifies a throttle as a WARNING held until attempts are exhausted', () => {
    expect(classifyM365SyncFailure(undefined, new M365SyncRetryableError('throttled'))).toEqual({
      reason: 'm365_sync_throttled', level: 'warning', reportOnlyWhenExhausted: true,
    });
  });

  it('leaves every other failure at the default error-level report', () => {
    expect(classifyM365SyncFailure(undefined, new Error('pg connection closed'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run — must FAIL**

```bash
cd apps/api && npx vitest run src/jobs/m365SyncWorker.test.ts
```

- [ ] **Step 3: Implement**

Add one entry to `WORKER_FAILURE_REASONS` in `apps/api/src/jobs/workerObservability.ts`:

```ts
  /** m365SyncWorker: Graph throttled or the executor was at its sync in-flight cap. */
  'm365_sync_throttled',
```

`apps/api/src/jobs/m365SyncWorker.ts`:

```ts
import { Job, UnrecoverableError, Worker } from 'bullmq';
import {
  isM365TenantSyncEnabled, m365SyncConcurrency, m365SyncMaxBacklog, m365SyncTickBatch,
} from '../config/env';
import { getBullMQConnection } from '../services/redis';
import {
  claimDueDomains, countDueDomains, reconcileEligibleConnections,
} from '../services/m365Sync/claim';
import {
  recordM365SyncTickerSkipped, setM365SyncDueBacklog, setM365SyncQueueDepth,
  setM365SyncTickerUtilisation,
} from '../services/m365Sync/metrics';
import { logSync, runSyncDomain } from '../services/m365Sync/run';
import { m365SyncJobDataSchema } from '../services/m365Sync/types';
import {
  closeM365SyncQueue, enqueueSyncDomain, getM365SyncQueue, m365SyncBackoff,
  M365_SYNC_QUEUE, M365_SYNC_TICK_INTERVAL_MS, M365_SYNC_TICK_JOB_ID,
  type M365SyncQueueJobData,
} from './m365SyncQueue';
import { attachWorkerObservability, type WorkerFailureClassification } from './workerObservability';

export const M365_SYNC_WORKER_NAME = 'm365SyncWorker';

/**
 * Thrown so BullMQ applies the 30 s / 2 min / 8 min backoff. Every condition
 * that raises it is EXPECTED and self-healing, which is why the classifier
 * below holds the report until the attempts are exhausted — and, because the
 * final attempt records `throttled` and RETURNS instead of throwing, a pure
 * throttle never reaches Sentry at all.
 */
export class M365SyncRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'M365SyncRetryableError';
  }
}

export interface M365SyncTickResult {
  claimed: number;
  depth: number;
  seeded: number;
  due: number;
  skipped?: 'flag_off' | 'backpressure';
}

/**
 * One tick (spec §5.2). Three deliberately separated stages:
 *
 *   1. REDIS, no DB context — queue depth for backpressure.
 *   2. DB, short system transactions — reconcile, due gauge, claim.
 *   3. REDIS, no DB context — enqueue.
 *
 * Issuing Redis commands with a pooled connection held open is the #1105
 * anti-pattern, and enqueuing before the claim has committed would let a worker
 * read a stale generation and fence itself.
 */
export async function runM365SyncTick(now: Date = new Date()): Promise<M365SyncTickResult> {
  if (!isM365TenantSyncEnabled()) {
    return { claimed: 0, depth: 0, seeded: 0, due: 0, skipped: 'flag_off' };
  }

  const queue = getM365SyncQueue();
  const counts = await queue.getJobCounts('waiting', 'prioritized', 'delayed', 'active');
  // `prioritized` and `delayed` are counted on purpose: the priority-1 lane
  // parks jobs in `prioritized` and the backoff ladder parks them in `delayed`,
  // so a waiting+active-only depth would read near zero while the queue was
  // 500 deep (the advisor-quorum finding on draft v1).
  const depth = (counts.waiting ?? 0) + (counts.prioritized ?? 0)
    + (counts.delayed ?? 0) + (counts.active ?? 0);
  setM365SyncQueueDepth(depth);

  if (depth > m365SyncMaxBacklog()) {
    recordM365SyncTickerSkipped();
    logSync('tick-skipped', { reason: 'backpressure', depth, maxBacklog: m365SyncMaxBacklog() });
    // Due rows keep their past next_sync_at, so nothing is lost — the next tick
    // picks them up (spec §5.2 step 1).
    return { claimed: 0, depth, seeded: 0, due: 0, skipped: 'backpressure' };
  }

  const seeded = await reconcileEligibleConnections(now);
  const due = await countDueDomains(now);
  setM365SyncDueBacklog(due);

  const batch = m365SyncTickBatch();
  const claimed = await claimDueDomains({ limit: batch });
  setM365SyncTickerUtilisation(claimed.length / batch);

  for (const job of claimed) {
    try {
      await enqueueSyncDomain(job);
    } catch (error) {
      // One failed enqueue must not abandon the rest of the batch. The row is
      // already claimed with a lease; when the lease expires the next tick
      // reclaims it with a fresh generation (spec §5.2 "Recovery").
      logSync('enqueue-failed', {
        orgId: job.orgId, domain: job.domain, generation: job.generation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { claimed: claimed.length, depth, seeded, due };
}

async function processSyncDomain(job: Job<M365SyncQueueJobData>): Promise<string> {
  if (!isM365TenantSyncEnabled()) return 'noop';

  const parsed = m365SyncJobDataSchema.safeParse(job.data);
  if (!parsed.success) {
    // A payload that cannot be parsed will not parse on attempt two or three
    // either, and it IS worth a Sentry report — unlike the expected conditions
    // below, this one means something wrote a job we do not understand.
    throw new UnrecoverableError(
      `[M365Sync] malformed sync-domain payload: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }

  // 1-based inside the processor (BullMQ increments attemptsMade on
  // move-to-active) — same convention as huntressSync/ticketNotify.
  const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
  const outcome = await runSyncDomain(parsed.data, { isFinalAttempt });

  if (outcome === 'throttled' && !isFinalAttempt) {
    // runSyncDomain wrote no terminal state; ask BullMQ for the backoff.
    throw new M365SyncRetryableError(
      `[M365Sync] throttled or at executor capacity for org=${parsed.data.orgId} domain=${parsed.data.domain}`,
    );
  }
  // Everything else — including a dead credential — returns normally. It is
  // already recorded terminally on m365_sync_state, and capturing it once per
  // scheduled run is exactly what flooded the Sentry quota for Huntress
  // (BREEZE-1). Spec §6: "Run stops; not sent to Sentry".
  return outcome;
}

export function classifyM365SyncFailure(
  _job: Job | undefined,
  err: Error,
): WorkerFailureClassification | null {
  const isRetryable = err instanceof M365SyncRetryableError
    // The class may not survive BullMQ's error round-trip into the 'failed'
    // event, so match by name too (same defence as isHuntressAuthFailure).
    || err.name === 'M365SyncRetryableError';
  if (!isRetryable) return null;
  return { reason: 'm365_sync_throttled', level: 'warning', reportOnlyWhenExhausted: true };
}

let worker: Worker<M365SyncQueueJobData> | null = null;

/**
 * Registers the 60 s repeat tick. Any pre-existing `tick` repeatable is removed
 * FIRST, unconditionally, so turning the flag off and restarting actually stops
 * the scheduler rather than leaving an orphaned repeat entry in Redis.
 *
 * No scheduleRegistry slot: that registry allocates coarse (>= hourly)
 * schedules, and a 60 s tick is explicitly exempt.
 */
async function scheduleTick(): Promise<void> {
  const queue = getM365SyncQueue();
  for (const repeatable of await queue.getRepeatableJobs()) {
    if (repeatable.name === 'tick') await queue.removeRepeatableByKey(repeatable.key);
  }
  if (!isM365TenantSyncEnabled()) {
    logSync('tick-not-registered', { reason: 'M365_TENANT_SYNC_ENABLED is off' });
    return;
  }
  await queue.add('tick', {}, {
    jobId: M365_SYNC_TICK_JOB_ID,
    repeat: { every: M365_SYNC_TICK_INTERVAL_MS },
    removeOnComplete: true,
    removeOnFail: { count: 20 },
  });
}

export async function initializeM365SyncWorker(): Promise<void> {
  // The Worker is constructed UNCONDITIONALLY, flag or not: the readiness
  // manifest requires exactly one attach per construction site, and a
  // flag-gated construction would leave the process permanently not-ready on
  // the default configuration. Both the tick registration above and the
  // processor itself check the flag instead.
  worker = new Worker<M365SyncQueueJobData>(
    M365_SYNC_QUEUE,
    async (job: Job<M365SyncQueueJobData>) => {
      // No blanket system-context wrap: runSyncDomain manages its own short
      // contexts so the Graph fetch runs with none held.
      if (job.name === 'tick') return runM365SyncTick();
      return processSyncDomain(job);
    },
    {
      connection: getBullMQConnection(),
      concurrency: m365SyncConcurrency(),
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
      settings: { backoffStrategy: (attemptsMade: number) => m365SyncBackoff(attemptsMade) },
    },
  );
  attachWorkerObservability(worker, M365_SYNC_WORKER_NAME, { classifyFailure: classifyM365SyncFailure });

  await scheduleTick();
  logSync('worker-initialized', { concurrency: m365SyncConcurrency() });
}

export async function shutdownM365SyncWorker(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  await closeM365SyncQueue();
  logSync('worker-shut-down', {});
}
```

- [ ] **Step 4: Run — must PASS**

```bash
cd apps/api && npx vitest run src/jobs/m365SyncWorker.test.ts src/jobs/m365SyncQueue.test.ts src/jobs/workerObservability.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/m365SyncWorker.ts apps/api/src/jobs/m365SyncWorker.test.ts apps/api/src/jobs/workerObservability.ts
git commit -m "$(cat <<'EOF'
feat(m365): add the m365-sync ticker and sync-domain worker

The 60s tick separates Redis (depth), DB (reconcile + due gauge + claim) and
Redis (enqueue) so no pooled connection is held across a Redis round trip and
nothing is enqueued before its claim has committed. Backpressure counts
prioritized and delayed, not just waiting+active — the priority lane and the
backoff ladder park jobs in exactly those two states.

A throttle on a non-final attempt throws M365SyncRetryableError for the
30s/2m/8m ladder and is classified warning + reportOnlyWhenExhausted; the
final attempt records `throttled` and RETURNS, so a pure throttle reaches
Sentry never. UnrecoverableError is reserved for a payload we cannot parse.

Turning the flag off removes the repeat entry, so the scheduler really stops.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 15: Worker registry + readiness manifest wiring

Three separate contracts must all be satisfied in the SAME commit or CI reds in the required **Test API** job.

**Files:**
- Edit: `apps/api/src/services/workerRegistry.ts`
- Edit: `apps/api/src/services/workerRegistry.test.ts` (the entry-count assertion)
- Edit: `apps/api/src/jobs/workerReadinessManifest.ts`

**Interfaces:** consumes Task 14's `initializeM365SyncWorker` / `shutdownM365SyncWorker` / `M365_SYNC_WORKER_NAME`.

> **Depends on W02 landing first.** `WORKER_REGISTRY.length` is asserted
> EXACTLY and both waves add an entry, so the number is only correct in landing
> order (overview, "Count assertions"): **128 on main today → W02 sets 129
> (`m365SyncRetention`) → W04 sets 130 (`m365SyncWorker`)**. If the base branch
> does not already carry W02's 129, W04 is on the wrong base — stop and rebase
> rather than "fixing" the number, or the two waves will fight over it and main
> will red after the second merge.
>
> The same ordering applies to `WORKER_READINESS_MANIFEST`: W02 adds
> `consumers('m365SyncRetention')`, W04 adds `consumers('m365SyncWorker')`.
> Both entries must be present after this wave.
>
> The three contracts, and what each one fails on:
> 1. `workerRegistry.test.ts:72` asserts `WORKER_REGISTRY.length` **exactly** — with W02 on the base it reads 129; this wave bumps it to **130**.
> 2. `workerReadinessCoverage.test.ts` AST-scans every `new Worker(...)` site and requires exactly one `attachWorkerObservability` per construction (Task 14 satisfies this) **and** an exact set match between every attached name and `WORKER_READINESS_MANIFEST` — so `consumers('m365SyncWorker')` must be added, spelled identically to the string passed to `attachWorkerObservability`.
> 3. `workerEntrypointClosure.contract.test.ts` classifies placement by walking the module's runtime import closure. `placement: 'global'` is the claim that nothing it imports reaches `routes/agentWs.ts` or `services/agentCommandAwait.ts`. **Do not assume it — run the suite.** If it fails, flip to `'socket-owner'` and say so in the PR.

- [ ] **Step 1: Write the failing assertions**

In `apps/api/src/services/workerRegistry.test.ts`, bump the count and pin the new entry.
**Read the current value first** — it must already be 129 (W02's
`m365SyncRetention`). If it says 128, W02 is not on this base; stop.

```ts
    expect(WORKER_REGISTRY.length).toBe(130);   // 129 with W02 on the base, +1 for m365SyncWorker
```

and add:

```ts
  it('registers the m365 sync worker as a global-placement entry', () => {
    const entry = WORKER_REGISTRY.find((e) => e.name === 'm365SyncWorker');
    expect(entry).toBeDefined();
    expect(entry!.placement).toBe('global');
  });
```

- [ ] **Step 2: Run — must FAIL** (count mismatch + missing entry + manifest set mismatch)

```bash
cd apps/api && npx vitest run src/services/workerRegistry.test.ts src/jobs/workerReadinessCoverage.test.ts
```

- [ ] **Step 3: Implement**

In `apps/api/src/services/workerRegistry.ts`, immediately after the `huntressSyncWorker` entry:

```ts
  {
    name: 'm365SyncWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/m365SyncWorker');
      return { init: m.initializeM365SyncWorker, shutdown: m.shutdownM365SyncWorker };
    },
  },
```

In `apps/api/src/jobs/workerReadinessManifest.ts`, immediately after `consumers('huntressSyncWorker')` (W02's `consumers('m365SyncRetention')` is already present on this base):

```ts
  // The Worker is constructed unconditionally and attached unconditionally;
  // M365_TENANT_SYNC_ENABLED gates the TICK registration and the processor
  // body, not the construction. A flag-gated construction would need its own
  // ConsumerRequirementRule and would leave every api/all process not-ready on
  // the default configuration.
  consumers('m365SyncWorker'),
```

- [ ] **Step 4: Run — must PASS, all three contracts**

```bash
cd apps/api && npx vitest run src/services/workerRegistry.test.ts src/jobs/workerReadinessCoverage.test.ts src/jobs/workerReadinessManifest.test.ts src/services/workerEntrypointClosure.contract.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/workerRegistry.ts apps/api/src/services/workerRegistry.test.ts apps/api/src/jobs/workerReadinessManifest.ts
git commit -m "$(cat <<'EOF'
feat(m365): register the sync worker in the registry and readiness manifest

Three separate contracts, all in one commit: the exact WORKER_REGISTRY count
(129 with W02's m365SyncRetention on the base, 130 after this entry), the
attach-name/manifest set match, and the entrypoint-closure placement
classification. Placement was verified by running the closure contract, not
reasoned about.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 16: Claim protocol integration test (real Postgres)

Spec §9 "Claim protocol tests (real Postgres)". Everything asserted here is invisible to a mocked suite: `SKIP LOCKED` disjointness, the lease-expiry reclaim, and the fact that `next_sync_at` survives a claim byte-for-byte.

**Files:**
- Create: `apps/api/src/__tests__/integration/m365SyncClaim.integration.test.ts`

**Interfaces:** consumes the real `claimDueDomains`, `reconcileEligibleConnections`, `countDueDomains`, `syncJobId` and the W02 schema. No new production code.

> **W06 appends to this file.** Its end-to-end suite adds the two-ticker case (two concurrent ticks against one seeded fleet, asserting disjoint claims and no double-enqueue) using the helpers defined below — `seedConnection`, `seedState`, `readState`, spelled exactly like that. Keep those three names and their signatures stable; W06 imports nothing from here, it appends `describe` blocks in the same file.

> `src/__tests__/integration/**/*.test.ts` is already in `vitest.integration.config.ts`'s `include` and excluded from the unit config, so no dual-listing is needed. The suite needs a live database: `DATABASE_URL` + `DATABASE_URL_APP` come from the repo-root `.env.test` via `setup.ts`'s `loadEnv`. Bring a stack up with `pnpm test-stack up` (worktree-private) or `pnpm --filter @breeze/api test:docker:up` first.
>
> **`it.runIf(!!process.env.DATABASE_URL)` silently passes with zero tests when the env is missing.** After running, CHECK THE REPORTED TEST COUNT — a green run of 0 tests is a skip, not a pass.

- [ ] **Step 1: Write the failing test**

```ts
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { m365Connections, m365SyncState } from '../../db/schema';
import {
  claimDueDomains, countDueDomains, reconcileEligibleConnections, syncJobId,
} from '../../services/m365Sync/claim';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Tenant { orgId: string; connectionId: string; tenantId: string }

async function seedConnection(status: 'active' | 'degraded' | 'revoked' = 'active'): Promise<Tenant> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const tenantId = randomUUID();
    const credentialVersion = '0123456789abcdef0123456789abcdef';
    const [connection] = await db.insert(m365Connections).values({
      orgId: org.id,
      userId: null,
      tenantId,
      clientId: randomUUID(),
      clientSecret: null,
      profile: 'customer-graph-read',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: `akv://vault.example/m365-customer-graph-read-${org.id}/${credentialVersion}`,
      credentialVersion,
      permissionManifestVersion: 3,
      consentGeneration: 2,
      status,
    }).returning({ id: m365Connections.id });
    if (!connection) throw new Error('failed to seed m365 connection');
    return { orgId: org.id, connectionId: connection.id, tenantId };
  });
}

async function seedState(t: Tenant, over: Partial<{
  domain: 'users' | 'skus'; nextSyncAt: Date | null; leaseUntil: Date | null; runGeneration: number;
}> = {}) {
  return withSystemDbAccessContext(async () => {
    await db.insert(m365SyncState).values({
      orgId: t.orgId,
      connectionId: t.connectionId,
      domain: over.domain ?? 'users',
      nextSyncAt: over.nextSyncAt === undefined ? new Date(Date.now() - 60_000) : over.nextSyncAt,
      intervalSeconds: 21600,
      runGeneration: over.runGeneration ?? 0,
      leaseUntil: over.leaseUntil ?? null,
    });
  });
}

async function readState(orgId: string, domain: 'users' | 'skus' = 'users') {
  return withSystemDbAccessContext(async () => {
    const rows = await db.select().from(m365SyncState)
      .where(and(eq(m365SyncState.orgId, orgId), eq(m365SyncState.domain, domain)));
    return rows[0]!;
  });
}

describe('m365 sync claim protocol (real Postgres, spec §5.2)', () => {
  beforeEach(() => { /* setup.ts truncates core tenant tables per test */ });

  runDb('claims a due row, increments the generation, and takes a ~20 minute lease', async () => {
    const t = await seedConnection();
    await seedState(t);

    const claimed = await claimDueDomains({ limit: 10 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      orgId: t.orgId, domain: 'users', generation: 1,
      connectionId: t.connectionId, tenantId: t.tenantId, consentGeneration: 2, priority: 10,
    });

    const state = await readState(t.orgId);
    expect(state.runGeneration).toBe(1);
    const leaseMs = state.leaseUntil!.getTime() - Date.now();
    expect(leaseMs).toBeGreaterThan(19 * 60_000);
    expect(leaseMs).toBeLessThanOrEqual(20 * 60_000 + 5_000);
  });

  runDb('does NOT touch next_sync_at — cadence advances only on completion', async () => {
    const t = await seedConnection();
    const due = new Date(Date.now() - 60_000);
    await seedState(t, { nextSyncAt: due });

    const before = (await readState(t.orgId)).nextSyncAt!.toISOString();
    await claimDueDomains({ limit: 10 });
    expect((await readState(t.orgId)).nextSyncAt!.toISOString()).toBe(before);
  });

  runDb('skips a row whose lease is still live, then reclaims it once the lease expires', async () => {
    const t = await seedConnection();
    await seedState(t, { leaseUntil: new Date(Date.now() + 10 * 60_000) });
    expect(await claimDueDomains({ limit: 10 })).toHaveLength(0);

    await withSystemDbAccessContext(async () => {
      await db.update(m365SyncState)
        .set({ leaseUntil: new Date(Date.now() - 60_000) })
        .where(eq(m365SyncState.orgId, t.orgId));
    });

    const reclaimed = await claimDueDomains({ limit: 10 });
    expect(reclaimed).toHaveLength(1);
    // A NEW generation is what makes the abandoned run's late result fence.
    expect(reclaimed[0]!.generation).toBe(1);
  });

  runDb('does not claim a future row, a NULL next_sync_at, or a revoked connection', async () => {
    const future = await seedConnection();
    await seedState(future, { nextSyncAt: new Date(Date.now() + 3_600_000) });
    const unscheduled = await seedConnection();
    await seedState(unscheduled, { nextSyncAt: null });
    const revoked = await seedConnection('revoked');
    await seedState(revoked);

    expect(await claimDueDomains({ limit: 10 })).toEqual([]);
  });

  runDb('claims a degraded connection — degraded is executable (spec §5.2)', async () => {
    const t = await seedConnection('degraded');
    await seedState(t);
    expect(await claimDueDomains({ limit: 10 })).toHaveLength(1);
  });

  runDb('two concurrent claimers get DISJOINT sets under SKIP LOCKED', async () => {
    const tenants = await Promise.all(Array.from({ length: 6 }, () => seedConnection()));
    for (const t of tenants) await seedState(t);

    const [a, b] = await Promise.all([
      claimDueDomains({ limit: 3 }),
      claimDueDomains({ limit: 3 }),
    ]);

    const key = (j: { orgId: string; domain: string }) => `${j.orgId}:${j.domain}`;
    const keysA = a.map(key);
    const keysB = b.map(key);
    expect(keysA.filter((k) => keysB.includes(k))).toEqual([]);
    expect(new Set([...keysA, ...keysB]).size).toBe(keysA.length + keysB.length);
    // Every claimed row must carry generation 1 exactly once — a double claim
    // would show as a 2 here.
    for (const t of tenants) {
      const state = await readState(t.orgId);
      expect(state.runGeneration).toBeLessThanOrEqual(1);
    }
  });

  runDb('honours the batch limit and claims the oldest due rows first', async () => {
    const tenants = await Promise.all(Array.from({ length: 3 }, () => seedConnection()));
    await seedState(tenants[0]!, { nextSyncAt: new Date(Date.now() - 300_000) });
    await seedState(tenants[1]!, { nextSyncAt: new Date(Date.now() - 200_000) });
    await seedState(tenants[2]!, { nextSyncAt: new Date(Date.now() - 100_000) });

    const claimed = await claimDueDomains({ limit: 2 });
    expect(claimed).toHaveLength(2);
    expect(claimed.map((j) => j.orgId).sort()).toEqual([tenants[0]!.orgId, tenants[1]!.orgId].sort());
  });

  runDb('narrows to one org and domain list for the priority-1 lane', async () => {
    const a = await seedConnection();
    const b = await seedConnection();
    await seedState(a, { domain: 'users' });
    await seedState(a, { domain: 'skus' });
    await seedState(b, { domain: 'users' });

    const claimed = await claimDueDomains({ limit: 10, orgId: a.orgId, domains: ['skus'], priority: 1 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ orgId: a.orgId, domain: 'skus', priority: 1 });
  });

  runDb('reconcile seeds the four implemented domains once and is idempotent', async () => {
    const t = await seedConnection();

    expect(await reconcileEligibleConnections()).toBe(4);
    expect(await reconcileEligibleConnections()).toBe(0);

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(m365SyncState).where(eq(m365SyncState.orgId, t.orgId)));
    expect(rows.map((r) => r.domain).sort()).toEqual(['ca_policies', 'intune_devices', 'skus', 'users']);
    for (const row of rows) {
      const ahead = row.nextSyncAt!.getTime() - Date.now();
      expect(ahead).toBeGreaterThanOrEqual(-5_000);
      expect(ahead).toBeLessThanOrEqual(3_600_000 + 5_000);
    }
    expect(rows.find((r) => r.domain === 'users')!.intervalSeconds).toBe(21600);
    expect(rows.find((r) => r.domain === 'skus')!.intervalSeconds).toBe(86400);
  });

  runDb('reconcile ignores a revoked connection', async () => {
    await seedConnection('revoked');
    expect(await reconcileEligibleConnections()).toBe(0);
  });

  runDb('countDueDomains counts only rows whose next_sync_at is in the past', async () => {
    const dueTenant = await seedConnection();
    await seedState(dueTenant);
    const futureTenant = await seedConnection();
    await seedState(futureTenant, { nextSyncAt: new Date(Date.now() + 3_600_000) });
    expect(await countDueDomains()).toBe(1);
  });

  runDb('the job id built from a claimed row contains no colon', async () => {
    const t = await seedConnection();
    await seedState(t);
    const [job] = await claimDueDomains({ limit: 1 });
    expect(syncJobId(job!)).not.toContain(':');
  });
});
```

- [ ] **Step 2: Run — must FAIL for real reasons (not "0 tests")**

```bash
pnpm test-stack up   # or: pnpm --filter @breeze/api test:docker:up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/m365SyncClaim.integration.test.ts
```

Confirm the reported count is **13 tests**, not 0. If it says 0, `DATABASE_URL` is unset and `runIf` skipped everything — fix the env before reading anything into the result.

- [ ] **Step 3: Implement** — no production code should be needed. If a test fails, the SQL from Tasks 6/7 is wrong; fix it there and note what the mock-level suite could not see.

- [ ] **Step 4: Run — must PASS, 13 tests**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/m365SyncClaim.integration.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/m365SyncClaim.integration.test.ts
git commit -m "$(cat <<'EOF'
test(m365): prove the claim protocol against real Postgres

Due selection, next_sync_at surviving a claim byte-for-byte, lease-expiry
reclaim with a new generation, oldest-first batching, the priority-1 org/domain
narrowing, idempotent reconcile with a first-hour stagger, and two concurrent
claimers getting disjoint sets under SKIP LOCKED — none of which a mocked
suite can see.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 17: Full verification, typecheck, PR

- [ ] **Step 1: Run the wave's own suites**

```bash
cd apps/api && npx vitest run src/services/m365Sync src/services/m365ControlPlane src/jobs/m365SyncWorker
```

Check the reported FILE count covers: `hash`, `metrics`, `claim`, `claim.sql`, `cadence`, the four `domains/*`, `domains/persist`, `run.phaseA`, `run`, every pre-existing `m365ControlPlane/*` suite (including the new `readActionService.syncRoute`), and `m365SyncWorker`. Vitest's filter is a substring match — if a file you expect is missing from the list, it was never run.

- [ ] **Step 2: Run the contract suites this wave touches**

```bash
cd apps/api && npx vitest run \
  src/config/env.m365Sync.test.ts \
  src/config/validate.test.ts \
  src/config/envComposeParity.test.ts \
  src/services/workerRegistry.test.ts \
  src/services/workerEntrypointClosure.contract.test.ts \
  src/jobs/workerReadinessCoverage.test.ts \
  src/jobs/workerReadinessManifest.test.ts \
  src/jobs/m365SyncQueue.test.ts
```

- [ ] **Step 3: Run the claim integration suite against a live database**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/m365SyncClaim.integration.test.ts
```

Confirm it reports 13 tests, not 0.

- [ ] **Step 4: Typecheck and lint**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
cd apps/api && npx eslint src/services/m365Sync src/jobs/m365SyncWorker.ts src/jobs/m365SyncQueue.ts src/services/m365ControlPlane/readActionService.ts src/config/env.ts src/config/validate.ts
```

> **Do NOT edit the overview file.** Contract edits are the orchestrator's
> (overview: "Waves do not edit this file"). The contract deltas at the top of
> this plan go in the PR body — Step 7's `gh pr create` already carries them —
> and the orchestrator folds them into
> `2026-09-08-m365-tenant-sync-0-overview.md`. A wave editing that file is how
> two waves land conflicting contract text in the same paragraph.

- [ ] **Step 5: Full API suite, once, before opening the PR**

```bash
cd apps/api && npx vitest run
```

- [ ] **Step 6: Merge main and push**

```bash
git fetch origin && git merge origin/main    # PR CI tests the MERGE COMMIT, not your branch tip
cd apps/api && npx vitest run src/services/m365Sync src/jobs/m365SyncWorker.test.ts   # re-verify after the merge
git push -u origin HEAD
```

- [ ] **Step 7: Open the PR**

```bash
gh pr create --base main --title "feat(m365): tenant sync core — claim ticker, three-phase sync job, four domains (W04)" --body "$(cat <<'EOF'
Closes #5331

Wave 04 of the M365 tenant sync foundation
(`docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-4-sync-core.md`,
spec §5.1-5.4, §5.9 counts, §5.10, §6, §7, §10 steps 1-2). Consumes W02's
schema and W03's shared types + executor `syncAction`.

## What ships

- **Flag + knobs.** `M365_TENANT_SYNC_ENABLED` (dark by default, boot-validated)
  plus `M365_SYNC_CONCURRENCY` / `_MAX_BACKLOG` / `_TICK_BATCH`, threaded
  through both compose pairs.
- **`callGraphReadExecutor`** extracted from `readActionService.ts`: DB-free,
  budget family by route, executor call, metrics. `executeM365ReadAction` is a
  thin wrapper and its suite is unchanged and green.
- **`consumeM365SyncBudget`** — 12/hour per connection, own key prefix,
  fail-closed.
- **Claim/lease/generation protocol** and the 60 s ticker: `FOR UPDATE OF s
  SKIP LOCKED`, generation bump, 20-minute lease, `next_sync_at` untouched.
- **Three-phase `sync-domain` job** with all four fencing conditions, chunked
  1 000-row short transactions, stale marking only on a complete run, and one
  `m365.sync.run` audit event per run.
- **Four domain persisters**: `users` (primary fields only), `intune_devices`
  (no link reconciliation), `ca_policies` (with `definition_hash`), `skus`.
- **The `m365_sync_*` metric surface** (spec §7) and the worker registry +
  readiness manifest wiring.

## Deliberately NOT in this wave

Users enrichment, `signin_activity`, `secure_score`, the rollup, adaptive
cadence, device link reconciliation, the lifecycle hooks and the on-demand
route are all W05. Two named seams are called from the right places, so W05
changes function bodies rather than threading new calls in:
`cadence.applyCadence` already returns the `{ intervalSeconds, nextSyncAt }`
pair (stored interval + jitter) and W05 replaces only the interval ladder;
`hooks.afterDomainPersisted` is a post-commit no-op receiving the full
`PersistContext` + outcome + `DomainPersistResult`. `M365_SYNC_IMPLEMENTED_DOMAINS`
and `DOMAIN_PERSISTERS` are the two constants W05 widens, and the two
claim-SQL assertions it must invert are marked "W05 inverts this" in place.

## Contract deltas (for the orchestrator to fold into the overview — this PR does not edit that file)

1. The per-call audit event stays on the READ route only — spec §7 wants
   exactly one `m365.sync.run` event per run and its counts do not exist at
   executor-call time. Verified that `recordM365ReadActionEvent` is
   fire-and-forget and opens its own context
   (`services/auditService.ts:54-79`), so the helper is still DB-free.
2. `callGraphReadExecutor` `opts` gains optional `auditRequest`, `recordEvent`
   and `domain` (the `m365_sync_executor_seconds{domain}` label, falling back
   to the action id); `runSyncDomain` gains an optional second argument;
   `claimDueDomains` gains optional `orgId`/`domains`/`priority`;
   `applyCadence` gains an optional fifth `rng`. All additive.
3. New leaf module `jobs/m365SyncQueue.ts` holds the Queue, so `claim.ts` and
   `m365SyncWorker.ts` do not import each other.
4. `applyCadence` lives in `cadence.ts` and `afterDomainPersisted` in
   `hooks.ts` — both W05-owned files, created here. `applyCadence` returns the
   `{ intervalSeconds, nextSyncAt }` PAIR and owns the ±10 % jitter, so `run.ts`
   computes no due time itself and W05 changes one function body.
   `afterDomainPersisted` takes `PersistContext & { domain, outcome, persisted }`
   and runs POST-COMMIT, outside any DB context; a throw is logged and
   swallowed.
5. `reconcileEligibleConnections` seeds only the four implemented domains;
   seeding all six now would make two of them claimable with no persister and
   they would burn a ticker slot every 60 s forever.
6. Auth failure is recorded terminally and RETURNED, not thrown:
   `attachWorkerObservability` captures every failure unconditionally
   (`jobs/workerObservability.ts:231-241`) and the required-attach contract
   forbids skipping it, so returning is the only way to honour spec §6's "not
   sent to Sentry". `UnrecoverableError` is used for an unparseable payload.
7. Metric names are unprefixed per the contract, unlike the neighbouring
   `breeze_m365_graph_read_actions_total`. `m365_sync_executor_seconds` is
   labelled by DOMAIN, not by action id, so it joins `m365_sync_runs_total` on
   one dashboard.
8. `continuation_invalid` is NOT an error. The executor's continuation seal
   expires after an hour and dies on an executor restart when
   `M365_SYNC_CONTINUATION_KEY` is unset, so recording it as `error` would
   unschedule a tenant's sign-in activity on every redeploy. It clears
   `m365_sync_state.continuation`, re-claims the same domain (fresh generation,
   so the abandoned attempt fences) and returns `'partial-continue'` — a
   control-flow value that never reaches `last_status`. W04 owns the mapping;
   W05 owns the sign-in persister that produces continuations.
9. `writeCompletion` is the single completion writer and carries a
   continuation-only mode for that restart: it stores the cursor and clears the
   lease and touches nothing else, so a half-finished walk never looks like a
   finished run. It also emits the one structured log line per run.
10. `DOMAIN_PERSISTERS` is a TOTAL `Record<M365SyncDomain, Persister | undefined>`
   with two explicit `undefined`s, so W05 edits two entries rather than adding
   keys, and a future domain is a compile error instead of a silent `noop`.
11. `WORKER_REGISTRY.length` is 130 after this wave — it depends on W02 having
   landed 129 first (overview, "Count assertions").
12. `apps/api` has no logger module (verified by grep), so the structured log
   line uses the repo's tagged-`console` + `JSON.stringify` convention
   (`jobs/dnsSyncJob.ts:123-146`) behind one `logSync` helper.

## Tenancy

No new tables and no migration (W02 owns both). Every read and write runs
under `withSystemDbAccessContext` — this is a cross-org scheduler (spec §8) —
and the Graph fetch runs inside `runOutsideDbContext` so no pooled connection
is pinned across it. Every persist is scoped by the `org_id` the job was
enqueued with, plus generation/connection/tenant/consent fencing at Phase C.

## Testing

Unit: canonical-hash key/array/nesting stability, compiled-SQL assertions on
the claim and reconcile statements (`PgDialect().sqlToQuery`), change-only
writes, stale-only-on-complete, the four fencing discards, chunking at 1 000,
per-domain outcome mapping (including `continuation_invalid` clearing the
cursor, re-claiming and returning `partial-continue` without touching
`last_status`), a message map proven TOTAL over the failure union at compile
time, the six cadence signals, the post-commit hook ordering and its swallowed
throw, one structured log line per run, ticker backpressure counting
`prioritized` + `delayed`, colon-free job ids, flag-off registering no tick,
and budget independence + fail-closed.

Real Postgres (`m365SyncClaim.integration.test.ts`, 13 tests): due selection,
`next_sync_at` untouched by a claim, lease-expiry reclaim, generation
increment, oldest-first batching, idempotent staggered reconcile, and two
concurrent claimers getting disjoint sets under `SKIP LOCKED`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

The wave sub-issue is #5331 (already substituted above).

- [ ] **Step 8: Confirm CI actually ran**

```bash
gh pr checks --watch ; true    # `gh pr checks` exits non-zero while PENDING
```

This PR targets `main`, so the blocking `integration-test` job runs on it
automatically — do **not** hand-dispatch CI. Confirm in the shard log that
`m365SyncClaim.integration.test.ts` reports 13 tests, not 0.
