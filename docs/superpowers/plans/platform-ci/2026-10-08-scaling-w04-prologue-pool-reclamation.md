---
title: "Scaling W04 (W1e): pool admission gate, abandoned-permit reclamation and stall recovery — on top of #8243"
date: 2026-10-08
tracking_issue: LanternOps/breeze#8139
wave_issue: LanternOps/breeze#8143
depends_on: LanternOps/breeze#8243 (merges first; this plan's executor bases on main after it lands)
rigor: high (DB connection lifecycle on the request path; driver patch)
---

# Scaling W04 — Pool Admission and Abandoned-Permit Reclamation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On top of #8243's split acquire/prologue budgets, make an expired deadline return its pool permit within a stated bound, keep the pool at max after an event-loop stall (back within 30 s), stop failed requests from ever reaching the driver, never commit an abandoned transaction, never hand a connection over inside a stale transaction, and publish all of it to Prometheus.

**Architecture:** #8243 (assumed merged) gives `withAcquireAndPrologueDeadline` (acquire clock from call to the transaction callback's `acquisition.acquired()`, prologue clock from there to `disarm()`), `DbPoolAcquireTimeoutError`, `DbPoolAcquireAbortedError` and `DB_POOL_ACQUIRE_TIMEOUT_MS`. This wave adds: a FIFO permit gate (`db/poolAdmission.ts`) that runs INSIDE #8243's acquire budget and leaves its queue when `acquisition.signal` aborts; a nested-escalation reserve; release of a permit only when the real transaction settles; lag-tolerant timers (one grace period when a timer fires ≥ 1 s late) inside #8243's two clocks; a deferred wedged-backend reclaim scheduler replacing the immediate pass; a postgres.js patch so `BEGIN` always reserves its connection; a real-Postgres acceptance suite; metrics and an alert.

**Tech Stack:** TypeScript (Hono API), postgres.js 3.4.9 (pnpm-patched), drizzle-orm `postgres-js`, Vitest (unit + `vitest.integration.config.ts`), prom-client, real Postgres via `pnpm test-stack`.

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-07-horizontal-api-scaling-design.md` — wave **W1e** (§5 table: "Prologue and pool reclamation. When the prologue deadline expires, the slot must return to the pool within a bound; the pool max is restored | W0b slow-loop chaos: pool returns to max within 30 s of the stall ending"). Program index: `docs/superpowers/plans/platform-ci/2026-10-07-scaling-program-w0-w1.md` (row W04). Wave issue #8143, feature #8139. Base: PR #8243 (branch `fix/8229-pool-acquire-budget`).

## Global Constraints

- **Base.** Start only after #8243 has merged: `git fetch origin && git log origin/main --oneline | grep -m1 8229` must show it, and `grep -n "withAcquireAndPrologueDeadline" apps/api/src/db/prologueDeadline.ts` must hit. If #8243 changed before merging, re-read its `prologueDeadline.ts` and `db/index.ts` and adjust Tasks 2 and 7 to the merged names before writing code.
- Reuse #8243's names and knob: `withAcquireAndPrologueDeadline`, `PoolAcquisition`, `DbPoolAcquireTimeoutError`, `DbPoolAcquireAbortedError`, `getDbPoolAcquireTimeoutMs`, `DB_POOL_ACQUIRE_TIMEOUT_MS`, `onPoolAcquireExpired`. No second acquire-timeout knob, no second acquire error class.
- Acceptance (spec W1e): under a slow-event-loop stall the pool returns to max **within 30 s of the stall ending**, with **no leaked connections** and **no double-use of a connection**.
- Program success criterion (index): "Under a W0b storm, p95 heartbeat ≤1 s and the pool never below 80 % of max (W04, W08)." This wave supplies the pool series; the storm run is W06/W08.
- Never hand a connection to a new request while another request's RLS GUCs (or any open transaction) are on it. GUCs stay `set_config(..., true)`; a connection returns to the pool only at ReadyForQuery status `I`.
- The wedged-backend reclaimer's safety predicate (`WEDGED_BACKEND_SELECT_SQL`, two-snapshot confirmation, per-pass cap 4, 60 s floor) is **not changed**.
- Agent HTTP client timeout is 30 s (`agent/internal/heartbeat/heartbeat.go:1003`). Default server budgets must total < 30 s: acquire 10 s + prologue 15 s + at most two 2 s graces = 29 s (Task 2 lowers #8243's acquire default from 15 s; see Design decision C2).
- Request code uses `withDbAccessContext` / `withSystemDbAccessContext`; bare pool stays forbidden in request code.
- Tests sit next to source; real-Postgres suites go under `apps/api/src/__tests__/integration/` (covered by the `src/__tests__/integration/**/*.test.ts` include glob).
- One unit file: `cd apps/api && npx vitest run <path>` (never `pnpm --filter … test -- --run`). One integration file: `cd apps/api && npx vitest run -c vitest.integration.config.ts <path>` after `pnpm test-stack up` at the repo root; `pnpm test-stack down` when finished.
- Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit=$?"` — read the exit code, never pipe tsc into `tail`.
- No migrations, tenant tables or RLS policy changes.
- A new env var goes into `.env.example`, `docker-compose.yml`, `deploy/docker-compose.prod.yml`, `apps/docs/src/content/docs/deploy/environment.mdx` and `apps/api/src/system/connections/internalEnvVars.ts` (enforced by `envInventory.test.ts` and `config/envReadComposeCoverage.test.ts`).
- PR body: `Closes #8143` and NO closing keyword for #8229 or #8243 (those are #8243's). Refer to them as "builds on #8243 (#8229)". Merge via the queue (`gh pr merge <N>`), never `--admin`.

## Review Focus

1. **A caller that catches the inner timeout and keeps going** (`withResolvedDbAccessContext` inside a joined context, error swallowed, work returns normally). Expected: the outer caller is rejected immediately and the abandoned transaction **rolls back, never commits**. Pinned in Task 7 ("never commits an abandoned transaction").
2. **A request that holds a permit and opens a second one** (`runOutsideDbContext(() => withSystemDbAccessContext(...))`, the sanctioned #1105 escalation in `services/permissions.ts:261`) at full saturation. Expected: progress, not a stall until the acquire budget. Pinned in Task 3 ("nested acquirers use the reserve") and Task 6 ("nested escalation makes progress").
3. **An event-loop stall longer than every budget.** Expected: some requests fail with typed errors; every permit and real connection is back within 30 s; no backend left `idle in transaction`. Pinned in Task 6 ("permits and real connections back at max within 30 s").
4. **`BEGIN` pipelined behind a bare query at the pipeline limit / under write backpressure.** Expected: the transaction reserves its own connection; later bare statements run in their own transactions. Pinned in Task 5 (driver regression test, both builds).
5. **A true ClientRead wedge with reclaim disabled.** Expected: the permit stays held and reported as abandoned (`effective_permits` drops), the gate never admits beyond `DB_POOL_MAX`, the operator gets a paced warning. Pinned in Task 3 ("an abandoned permit is never re-admitted") and Task 4 ("declined reclaim warns at the retry pace").

---

## Root cause (as verified)

Labels: **[V]** verified by reading code (main at `864eafe525`, #8243 head `pr-8243`) or by a live repro; **[I]** inferred.

1. **[V] Fixed by #8243.** The prologue timer used to start before postgres.js handed over a connection, so pool queueing was charged as a "prologue" timeout (#8229). #8243 splits the clocks: acquire runs from call to `acquisition.acquired()`, prologue from there.
2. **[V] Abandonment does not by itself lose a slot.** postgres.js `scope()` awaits `ROLLBACK` when the callback throws (`postgres/src/index.js:262-270`), and ReadyForQuery status `I` returns the connection (`postgres/src/connection.js:581-589`). A slot is lost only when the backend never answers (the #6048 ClientRead wedge). Codex agrees.
3. **[V] Still open after #8243: failed requests stay in the driver queue.** `begin()` creates its `BEGIN` internally (`postgres/src/index.js:242`), and nothing reachable through drizzle can cancel it. #8243 refuses a late connection (`DbPoolAcquireAbortedError` → ROLLBACK), but that refusal still costs a real connection a BEGIN + ROLLBACK, queued FIFO ahead of live requests. **[I]** Under 1–2.4 s loop lag this turnover plausibly contributed to the effective-pool shrink; its production share is unmeasured until this wave's series exist.
4. **[V] Still open after #8243: the expiry-time reclaim pass cannot match the backend that triggered it.** #8243 leaves `onPrologueDeadlineExpired` requesting a pass at expiry with `minAgeMs = timeoutMs`. The prologue clock now starts at acquisition, but the predicate also requires `query_start` (the `set_config`) to be older than `minAgeMs`, and that statement was sent after the clock started. Codex's correction stands: the scan can still match other, older wedges, so `scanned=0` means "nothing matched", not "nothing is impaired".
5. **[I] The 2026-10-08 US storm was pool saturation from a CPU-bound event loop, not wedged backends.** Consistent with 216 `scanned=0` passes, no connect-timeout churn, and the 2026-10-05 #8019 investigation ("pool full of short transactions, event loop CPU-saturated, no single holder").
6. **[V] Event-loop stalls produce false expiries, in both of #8243's clocks.** The API image runs Node 24 (`docker/Dockerfile.api:1`); libuv ≥ 1.45 runs due timers at the end of an iteration, before the next I/O poll. A stall inside a poll callback (where most request JS runs) lets an expired timer fire before the poll that would read a reply that arrived during the stall. Codex disputed the original wording; Task 1 pins the refined claim with a characterization test on the real runtime.
7. **[V] postgres.js can return a connection to the pool inside an open transaction.** `connection.js:173-177` runs `onexecute` (the `begin()` reservation) only if the write did not hit backpressure and `sent.length < max_pipeline`. Reproduced 2026-10-08 against Postgres with `{ max: 1, max_pipeline: 1 }`: `begin()` rejected with `Cannot set properties of undefined (setting 'onclose')`, a TypeError escaped unhandled, and two later bare `select now()` calls 50 ms apart returned the same `now()` (one leaked transaction). With the Task 5 fix they differ. Not addressed by #8243.
8. **[V] #8243 inherits the second-prologue caller hang.** `withResolvedDbAccessContext` runs its narrowing prologue under `withPrologueDeadline` inside the outer transaction; on expiry the rejection lands inside the outer callback, whose ROLLBACK can queue behind the wedge, so the outer caller is not released and a caller that swallows the error can still COMMIT (Codex finding; #8243 does not change this path).

## Design decision (advisor quorum + reconciliation with #8243)

**Fable position (author, pre-#8243).** (D1) an app-level FIFO admission gate with permits = `DB_POOL_MAX` and its own acquire budget, so a timed-out waiter is removed before the driver; (D2) release a permit when the underlying transaction settles, not when the caller is answered; (D3) prologue armed at permit grant, abandon on expiry, defer reclaim until the backend can match; (D4) lag-tolerant timers with one grace; (D5) the second prologue in `withResolvedDbAccessContext` abandons the outer permit; (D6) aggregated logs; (D7) a real-Postgres harness with a wire proxy.

**Codex position (gpt-6-astra, xhigh, read-only, 2026-10-08).** "Ship the amended gate, not W04 unchanged." Confirmed root-cause items 2, 3 and the hazard in 7; corrected 4 and 6. Blockers: (a) the gate does not represent physical pool capacity (bare reads bypass openers, `routes/agents/commands.ts:308`; escalation holds one transaction while awaiting a second, `services/permissions.ts:261`); (b) D5 leaves the caller hanging and a caught inner expiry needs poisoning; (c) the "91 s" wedge bound is not a guarantee (buffered writes after the abort check; cap of 4 per pass); (d) the lateness label is not causal and the grace extends residence, so not on by default without a comparison; (e) run deferred-after-context work on underlying settlement; (f) one scheduler, keep the 60 s floor, aggregate logs, bound the queue and drop disconnected waiters, test nesting, second-prologue timeout, reconnect, pipeline backpressure and more than four wedges.

**Codex reconciliation.**

| Point | Decision | Reasoning |
|---|---|---|
| (a) gate ≠ physical pool | **Accepted in part.** The gate governs transaction *permits*; every series says permits. Bare-pool queries stay ungated. | Bare queries never reserve a connection (postgres.js pipelines them onto busy connections); at worst a permit holder waits one short bare statement inside the driver. Gating them means intercepting every query on the hot path for no correctness gain. |
| (a) nested hold-and-wait | **Accepted, solved in the gate.** One permit reserved for nested acquirers when `DB_POOL_MAX ≥ 3`, detected through a pool-slot `AsyncLocalStorage` that `runOutsideDbContext` deliberately does not exit; nested waiters are served first. | Top-level is capped at `max − 1`, so a depth-1 escalation always finds a permit. #8243 alone breaks this deadlock only by failing requests at the acquire budget. |
| (b) D5 caller hang + poisoning | **Accepted.** Every permit carries an `abandonment` promise the outer caller races; every opener calls `slot.throwIfAbandoned()` before COMMIT. | Root-cause item 8; rollback-only is the right poison. |
| (c) bound | **Accepted.** Stated as conditional (first eligible pass at abandonment + prologue budget + 1 s, then one pass per floor, ≤ 4 terminations each, 5-min scanner as backstop). The 30 s acceptance is the loop-stall case, which needs no reclaim. | Matches what the code can prove; wedges get their own test budget. |
| (d) grace default | **Disagreement, measured; owner decision.** Ships **on (2000 ms)**, only when a timer fired ≥ 1 s late, bounded so totals stay < 30 s. Label renamed to `timer="late"|"on-time"`. Task 6 records error counts with grace 2000 vs 0 under the same stall (asserts `withGrace ≤ withoutGrace`); W06's slow-loop storm is the load comparison. `DB_TIMER_LAG_GRACE_MS=0` disables. | Without it, every request in flight when a stall ends fails at once while its reply sits in the socket buffer, and agents retry immediately. |
| (e) after-exit work | **Accepted.** Deferred work starts on the transaction's settlement. | Keeps the contract when the caller is released early. |
| (f) scheduler, floor, logs | **Accepted.** One 1 s-tick scheduler, paced at the floor; floor unchanged. Logging reuses #8243's throttled `[db-pool-acquire]` warning; prologue expiries are rare after #8243 and keep one line each. | — |
| (f) bounded queue / disconnected waiters | **Deferred to W08.** | W08 owns shedding and request-abort plumbing; W04 exposes `waiting`. |
| (f) driver hazards | **Accepted and fixed** (Task 5). | The "no double-use" acceptance criterion; reproduced live. |

**Conflicts with #8243 and how they are resolved.**

| # | Where they differ | Decision | Code change to #8243's code |
|---|---|---|---|
| C1 | **Where the acquire budget is measured.** My draft: a gate-only acquire timeout, prologue clock from permit grant (covering BEGIN). #8243: one acquire clock from call to the transaction callback's first line (driver queue + BEGIN), prologue from there. | **Take #8243's boundaries.** The gate runs inside #8243's acquire phase and has NO timer of its own: it leaves its queue when `acquisition.signal` aborts at acquire expiry. | Task 2 adds `signal: AbortSignal` to `PoolAcquisition`. A hung BEGIN is charged to acquire (no reclaim): correct, because the reclaimer's predicate only matches `set_config`, so it could never clear a BEGIN anyway. One knob, one clock. |
| C2 | **Acquire default.** #8243: 15 s. Mine: 10 s. | **10 s.** With #8243's 15 s, acquire + prologue = 30 s, equal to the agent's HTTP timeout, so the agent can give up before the server answers. 10 + 15 + two 2 s graces = 29 s. **Owner decision** (it changes a default #8243 ships). | Task 2: `readDeadlineKnobMs` takes a per-knob default; #8243's "defaults to 15s" test becomes 10 s; docs and `.env.example` updated in Task 9. |
| C3 | **Reclaim on prologue expiry.** #8243 keeps the immediate pass. | **Replace with the deferred scheduler.** Root-cause item 4: the immediate pass cannot match the backend that triggered it. | Task 7 rewrites `onPrologueDeadlineExpired`; Task 4 moves its outcome reporting into `abandonedSlotReclaim.ts`. #8243's "a wedged prologue … still reclaims" wiring test changes from "called at expiry" to "called one budget + 1 s later". |
| C4 | **Late-connection handling.** #8243 refuses a connection that arrives after the acquire budget (`DbPoolAcquireAbortedError`). | **Keep it as the backstop.** The gate removes waiters before they reach the driver, which covers the common case (queueing for a permit); #8243's refusal still covers the short window between permit grant and the callback. | None. |
| C5 | **Timers.** #8243 uses plain `setTimeout` for both clocks. | **Lag-tolerant** (Task 1 primitive) for both, plus `timer` on both errors and expiry objects, plus per-clock expiry totals for metrics. | Task 2. |
| C6 | **Second-prologue path.** #8243 keeps `withPrologueDeadline` for `withResolvedDbAccessContext`. | Keep it; its expiry now abandons the OUTER permit (looked up from the pool-slot ALS inside `onPrologueDeadlineExpired`), which releases the outer caller and poisons COMMIT. | Task 7. |

**Rejected alternative: patch postgres.js to cancel a queued `begin()`.** It removes zombies without a gate, but yields no in-use/waiting numbers (postgres.js keeps its queues in closure scope), no nested reserve and no home for W08's admission policy; cancelling after `BEGIN` dispatch needs careful ownership handling (Codex).

**Coordination with W08** (`2026-10-08-scaling-w08-api-admission-control.md`, planned in parallel). Whichever lands second rebases. W04 owns the pool series (`breeze_db_pool_admission_*`); W08 reads `getRequestPoolAdmission()` as a controller input and publishes no competing pool gauges. W08's ticket stays outermost. W08's D10 follow-up (per-class permit reservation) belongs on this gate's `acquire` options, next to `nested`. W08 maps #8243's `DbPoolAcquireTimeoutError` to `503` + `Retry-After`.

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/db/lagTolerantTimeout.ts` (new) | One-shot timeout that detects it fired late and grants one grace period; `DB_TIMER_LAG_GRACE_MS`. Leaf. |
| `apps/api/src/db/prologueDeadline.ts` (modify #8243's version) | Lag-tolerant acquire and prologue clocks, `timer` on errors and expiries, `acquisition.signal`, per-clock expiry totals, 10 s acquire default. |
| `apps/api/src/db/poolAdmission.ts` (new) | FIFO permit gate with nested reserve, `PoolSlot` lifecycle (abandon / release on settlement), snapshot/totals, process registry. No timer of its own. Leaf. |
| `apps/api/src/db/abandonedSlotReclaim.ts` (new) | One scheduler requesting a wedged-backend reclaim for permits still held one prologue budget after abandonment; reclaim-outcome reporting moved out of `index.ts`. |
| `patches/postgres@3.4.9.patch` (regenerate) | `BEGIN` always reserves its connection (three `connection.js` builds). |
| `apps/api/src/db/index.ts` (modify #8243's version) | `runInPoolSlot` around `withAcquireAndPrologueDeadline`; pool-slot ALS; never-commit-when-abandoned; deferred reclaim instead of immediate; re-exports. |
| `apps/api/src/services/metricsRuntime.ts` (modify) | Admission and deadline-expiry series. |
| `apps/api/src/__tests__/integration/helpers/pgWireProxy.ts` (new) | Wire proxy: counts `BEGIN`s, withholds server replies, simulates the #6048 ClientRead wedge. |
| `apps/api/src/__tests__/integration/dbPoolRecovery.integration.test.ts` (new) | Acceptance suite against real Postgres. |
| `apps/api/src/__tests__/integration/postgresJsBeginReservation.integration.test.ts` (new) | Driver regression test. |
| Config/docs | `.env.example`, both compose files, `environment.mdx`, `alerts.mdx`, `monitoring/rules/breeze-rules.yml`, `internalEnvVars.ts`. |

Task order is dependency order: 1 → 2 → 3 → 4 → 5 → 6 (written RED against #8243's wiring) → 7 (turns it GREEN) → 8 → 9 → 10.

---

### Task 1: Lag-tolerant timeout primitive

**Files:**
- Create: `apps/api/src/db/lagTolerantTimeout.ts`
- Test: `apps/api/src/db/lagTolerantTimeout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TimerLateness = 'late' | 'on-time'`
  - `const TIMER_LATENESS_VALUES: readonly TimerLateness[]`
  - `const DB_TIMER_LATE_THRESHOLD_MS = 1000`
  - `function getDbTimerLagGraceMs(): number` (env `DB_TIMER_LAG_GRACE_MS`, default 2000, `0` disables, clamped to ≤ 10000, garbage → default)
  - `interface LagTolerantTimeoutFire { elapsedMs: number; late: boolean }`
  - `interface LagTolerantTimeoutHandle { cancel(): void; readonly fired: boolean }`
  - `function armLagTolerantTimeout(input: { timeoutMs: number; onFire: (fire: LagTolerantTimeoutFire) => void; graceMs?: number; lateThresholdMs?: number; now?: () => number }): LagTolerantTimeoutHandle`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/db/lagTolerantTimeout.test.ts
import net from 'node:net';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armLagTolerantTimeout,
  DB_TIMER_LATE_THRESHOLD_MS,
  getDbTimerLagGraceMs,
} from './lagTolerantTimeout';

/** Blocks the event loop, the way a CPU-bound request handler does. */
function busyWait(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // deliberately spinning
  }
}

/**
 * An echo server on its OWN event loop (a worker thread), so it keeps
 * answering while the test's loop is stalled — exactly like Postgres does.
 */
const ECHO_WORKER_SOURCE = `
const net = require('node:net');
const { parentPort } = require('node:worker_threads');
const server = net.createServer((socket) => socket.on('data', (data) => socket.write(data)));
server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
`;

async function startEchoWorker(): Promise<{ port: number; close: () => Promise<number> }> {
  const worker = new Worker(ECHO_WORKER_SOURCE, { eval: true });
  const [port] = (await once(worker, 'message')) as [number];
  return { port, close: () => worker.terminate() };
}

describe('getDbTimerLagGraceMs', () => {
  const original = process.env.DB_TIMER_LAG_GRACE_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.DB_TIMER_LAG_GRACE_MS;
    else process.env.DB_TIMER_LAG_GRACE_MS = original;
  });

  it('defaults to 2s', () => {
    delete process.env.DB_TIMER_LAG_GRACE_MS;
    expect(getDbTimerLagGraceMs()).toBe(2_000);
  });

  it('honours an explicit 0 as "no grace"', () => {
    process.env.DB_TIMER_LAG_GRACE_MS = '0';
    expect(getDbTimerLagGraceMs()).toBe(0);
  });

  it('clamps to 10s so a typo cannot unbound a budget', () => {
    process.env.DB_TIMER_LAG_GRACE_MS = '600000';
    expect(getDbTimerLagGraceMs()).toBe(10_000);
  });

  it('falls back to the default on garbage', () => {
    process.env.DB_TIMER_LAG_GRACE_MS = 'soon';
    expect(getDbTimerLagGraceMs()).toBe(2_000);
  });
});

describe('armLagTolerantTimeout (fake clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once, on time, with late=false when the loop is healthy', async () => {
    const onFire = vi.fn();
    armLagTolerantTimeout({ timeoutMs: 1_000, graceMs: 2_000, onFire });
    await vi.advanceTimersByTimeAsync(999);
    expect(onFire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith({ elapsedMs: 1_000, late: false });
  });

  it('never fires after cancel()', async () => {
    const onFire = vi.fn();
    const handle = armLagTolerantTimeout({ timeoutMs: 1_000, graceMs: 2_000, onFire });
    handle.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFire).not.toHaveBeenCalled();
    expect(handle.fired).toBe(false);
  });

  it('grants exactly one grace period when the timer fires at least the threshold late', async () => {
    let skew = 0;
    const now = () => Date.now() + skew;
    const onFire = vi.fn();
    const handle = armLagTolerantTimeout({ timeoutMs: 1_000, graceMs: 2_000, onFire, now });
    // The loop was stalled: by the time the timer callback runs, the wall clock
    // is DB_TIMER_LATE_THRESHOLD_MS past the due time.
    skew = DB_TIMER_LATE_THRESHOLD_MS;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onFire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire.mock.calls[0][0]).toMatchObject({ late: true });
    expect(handle.fired).toBe(true);
  });

  it('reports late=true but does not extend when grace is 0', async () => {
    let skew = 0;
    const onFire = vi.fn();
    armLagTolerantTimeout({ timeoutMs: 1_000, graceMs: 0, onFire, now: () => Date.now() + skew });
    skew = 5_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire.mock.calls[0][0]).toMatchObject({ late: true, elapsedMs: 6_000 });
  });

  it('a cancel during the grace period prevents the fire', async () => {
    let skew = 0;
    const onFire = vi.fn();
    const handle = armLagTolerantTimeout({ timeoutMs: 1_000, graceMs: 2_000, onFire, now: () => Date.now() + skew });
    skew = 1_500;
    await vi.advanceTimersByTimeAsync(1_000);
    handle.cancel();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onFire).not.toHaveBeenCalled();
  });
});

describe('armLagTolerantTimeout (real event loop, #8143)', () => {
  it('characterization: after a stall, an expired timer runs BEFORE socket data that arrived during the stall', async () => {
    // This is the whole justification for the grace period. If this test ever
    // fails on a new Node/libuv, the runtime no longer has the problem: set the
    // DB_TIMER_LAG_GRACE_MS default to 0 in lagTolerantTimeout.ts and say so in
    // the PR.
    const echo = await startEchoWorker();
    const socket = net.connect(echo.port, '127.0.0.1');
    try {
      await once(socket, 'connect');
      const order: string[] = [];
      const gotData = once(socket, 'data').then(() => order.push('io'));
      setTimeout(() => order.push('timer'), 20);
      socket.write('ping');
      busyWait(300);
      await gotData;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(order).toEqual(['timer', 'io']);
    } finally {
      socket.destroy();
      await echo.close();
    }
  });

  it('with grace, a reply that arrived during the stall wins against a late timer', async () => {
    const echo = await startEchoWorker();
    const socket = net.connect(echo.port, '127.0.0.1');
    try {
      await once(socket, 'connect');
      const onFire = vi.fn();
      const handle = armLagTolerantTimeout({ timeoutMs: 20, graceMs: 500, lateThresholdMs: 100, onFire });
      const gotData = once(socket, 'data').then(() => handle.cancel());
      socket.write('ping');
      busyWait(300);
      await gotData;
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(onFire).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
      await echo.close();
    }
  });

  it('without grace, the same stall fails the operation even though the reply is buffered', async () => {
    const echo = await startEchoWorker();
    const socket = net.connect(echo.port, '127.0.0.1');
    try {
      await once(socket, 'connect');
      const onFire = vi.fn();
      const handle = armLagTolerantTimeout({ timeoutMs: 20, graceMs: 0, lateThresholdMs: 100, onFire });
      const gotData = once(socket, 'data').then(() => handle.cancel());
      socket.write('ping');
      busyWait(300);
      await gotData;
      expect(onFire).toHaveBeenCalledTimes(1);
      expect(onFire.mock.calls[0][0]).toMatchObject({ late: true });
    } finally {
      socket.destroy();
      await echo.close();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/db/lagTolerantTimeout.test.ts`
Expected: FAIL — `Failed to resolve import "./lagTolerantTimeout"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/db/lagTolerantTimeout.ts
/**
 * A one-shot timeout that knows when it fired late (#8143).
 *
 * WHY. Every DB budget in `db/` (pool acquire, RLS prologue) is a plain
 * `setTimeout`. When the main thread stalls for longer than the budget, the
 * timer fires on the first loop iteration after the stall, and libuv (>= 1.45,
 * Node 20+) runs due timers BEFORE it next polls for I/O. A database reply that
 * arrived DURING the stall is therefore still unread in the socket when the
 * timer fails the request. `lagTolerantTimeout.test.ts` pins this ordering on
 * the running Node with a characterization test, because it is the whole
 * justification for the grace below.
 *
 * WHAT IT DOES. If the timer callback runs at least `lateThresholdMs` after its
 * due time, it is re-armed ONCE for `graceMs`, which gives the reply one I/O
 * poll and one round trip to land. A timer that fires on time is never
 * extended. Either way the fire reports `late`, which callers publish as the
 * `timer` metric label. `late` proves the event loop was stalled at the
 * deadline. It does NOT prove the stall was the only cause.
 *
 * Leaf module: no imports, so the db graph and metricsRuntime can both use it.
 */

export type TimerLateness = 'late' | 'on-time';

export const TIMER_LATENESS_VALUES: readonly TimerLateness[] = ['late', 'on-time'];

/** A timer this late was held up by the event loop, not by the work it guards. */
export const DB_TIMER_LATE_THRESHOLD_MS = 1_000;

const MAX_GRACE_MS = 10_000;

/** Env knob, alongside `DB_POOL_ACQUIRE_TIMEOUT_MS`. 0 disables the grace. */
export function getDbTimerLagGraceMs(): number {
  const raw = Number.parseInt(process.env.DB_TIMER_LAG_GRACE_MS ?? '', 10);
  if (!Number.isFinite(raw) || raw < 0) return 2_000;
  return Math.min(raw, MAX_GRACE_MS);
}

export interface LagTolerantTimeoutFire {
  /** Wall time from arming to the (final) fire. */
  elapsedMs: number;
  /** True when the first fire ran at least the late threshold after its due time. */
  late: boolean;
}

export interface LagTolerantTimeoutHandle {
  /** Idempotent. After cancel(), onFire never runs. */
  cancel(): void;
  readonly fired: boolean;
}

export interface ArmLagTolerantTimeoutInput {
  timeoutMs: number;
  /** Runs at most once. Callers must not throw from it. */
  onFire: (fire: LagTolerantTimeoutFire) => void;
  graceMs?: number;
  lateThresholdMs?: number;
  now?: () => number;
}

export function armLagTolerantTimeout(input: ArmLagTolerantTimeoutInput): LagTolerantTimeoutHandle {
  const now = input.now ?? Date.now;
  const graceMs = input.graceMs ?? getDbTimerLagGraceMs();
  const lateThresholdMs = input.lateThresholdMs ?? DB_TIMER_LATE_THRESHOLD_MS;
  const startedAt = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let fired = false;
  let late = false;

  const arm = (ms: number, next: () => void): void => {
    timer = setTimeout(next, ms);
    // Never the reason the process stays alive.
    timer.unref?.();
  };

  const fire = (): void => {
    timer = undefined;
    if (cancelled) return;
    fired = true;
    input.onFire({ elapsedMs: now() - startedAt, late });
  };

  arm(input.timeoutMs, () => {
    timer = undefined;
    if (cancelled) return;
    late = now() - startedAt - input.timeoutMs >= lateThresholdMs;
    if (late && graceMs > 0) {
      arm(graceMs, fire);
      return;
    }
    fire();
  });

  return {
    cancel() {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    get fired() {
      return fired;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/db/lagTolerantTimeout.test.ts`
Expected: PASS (12 tests). If ONLY the characterization test fails, do not "fix" it: change the `getDbTimerLagGraceMs` default from `2_000` to `0`, update its "defaults to 2s" test to expect `0`, and record the finding (Node version, observed order) for the PR body and the owner.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/lagTolerantTimeout.ts apps/api/src/db/lagTolerantTimeout.test.ts
git commit -m "feat(db): lag-tolerant timeout primitive for pool/prologue budgets (#8143)"
```

---

### Task 2: Extend #8243's deadlines: lag-tolerant clocks, `timer` label, expiry totals, `acquisition.signal`, 10 s acquire default

**Files:**
- Modify: `apps/api/src/db/prologueDeadline.ts` (#8243's version: everything from `function readDeadlineKnobMs` to the end of the file)
- Test: `apps/api/src/db/prologueDeadline.acquire.test.ts` (#8243's file: change the acquire default test, append a `describe`)

**Interfaces:**
- Consumes (Task 1): `armLagTolerantTimeout`, `type LagTolerantTimeoutHandle`, `type TimerLateness`.
- Keeps every #8243 export and signature. Adds:
  - `PoolAcquisition.signal: AbortSignal` (aborts at acquire expiry)
  - `DbAccessContextPrologueTimeoutError.timer` and `DbPoolAcquireTimeoutError.timer: TimerLateness` (constructor input `timer?`, default `'on-time'`)
  - `PrologueDeadlineExpiry.timer: TimerLateness`; `WithPrologueDeadlineDeps.graceMs?: number`
  - `type DeadlineClock = 'acquire' | 'prologue'`; `function getDeadlineExpiryTotals(): Record<DeadlineClock, Record<TimerLateness, number>>`; `function __resetDeadlineExpiryTotalsForTests(): void`
  - `getDbPoolAcquireTimeoutMs()` default becomes `10_000` (Design decision C2)

- [ ] **Step 1: Write the failing tests**

In `prologueDeadline.acquire.test.ts`, inside `describe('getDbPoolAcquireTimeoutMs', …)`, change the `'defaults to 15s'` test to:

```ts
  it('defaults to 10s, so acquire + prologue + two graces stays under the agent 30s HTTP timeout (#8143)', () => {
    delete process.env.DB_POOL_ACQUIRE_TIMEOUT_MS;
    expect(getDbPoolAcquireTimeoutMs()).toBe(10_000);
  });
```
and in the same `describe`, change any other assertion that expects the ACQUIRE default to be `15_000` (the garbage/negative fallback test and the "own knob" test) to `10_000`. Assertions about `getDbAccessContextPrologueTimeoutMs()` stay at `15_000`.

Extend the file's import from `./prologueDeadline` with `getDeadlineExpiryTotals`, `__resetDeadlineExpiryTotalsForTests`, and append:

```ts
describe('withAcquireAndPrologueDeadline: #8143 additions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetDeadlineExpiryTotalsForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function track(promise: Promise<unknown>) {
    const state = { settled: false, error: undefined as unknown };
    promise.then(
      () => { state.settled = true; },
      (err: unknown) => { state.settled = true; state.error = err; },
    );
    return state;
  }

  it('aborts acquisition.signal at acquire expiry, so a waiter queued in the admission gate can leave', async () => {
    let signal: AbortSignal | undefined;
    const result = withAcquireAndPrologueDeadline(
      'withDbAccessContext(scope=system)',
      (acquisition) => {
        signal = acquisition.signal;
        return new Promise<never>(() => {});
      },
      { acquireTimeoutMs: 1_000, timeoutMs: 15_000 },
    );
    const assertion = expect(result).rejects.toMatchObject({ name: 'DbPoolAcquireTimeoutError', timer: 'on-time' });
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(signal!.aborted).toBe(true);
  });

  it('never aborts the signal once the connection was acquired', async () => {
    let signal: AbortSignal | undefined;
    const result = withAcquireAndPrologueDeadline(
      'x',
      async (acquisition) => {
        signal = acquisition.signal;
        acquisition.acquired().disarm();
        return 'ok';
      },
      { acquireTimeoutMs: 1_000, timeoutMs: 15_000 },
    );
    await expect(result).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal!.aborted).toBe(false);
  });

  it('counts expiries per clock and timer lateness', async () => {
    const acquire = withAcquireAndPrologueDeadline('a', () => new Promise<never>(() => {}), {
      acquireTimeoutMs: 1_000,
      timeoutMs: 15_000,
    }).catch(() => undefined);
    const prologue = withAcquireAndPrologueDeadline(
      'p',
      (acquisition) => {
        acquisition.acquired();
        return new Promise<never>(() => {});
      },
      { acquireTimeoutMs: 1_000, timeoutMs: 2_000 },
    ).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(2_000);
    await acquire;
    await prologue;
    expect(getDeadlineExpiryTotals()).toEqual({
      acquire: { late: 0, 'on-time': 1 },
      prologue: { late: 0, 'on-time': 1 },
    });
  });

  it('gives a late acquire timer one grace period and labels the error late', async () => {
    let skew = 0;
    const result = withAcquireAndPrologueDeadline('x', () => new Promise<never>(() => {}), {
      acquireTimeoutMs: 1_000,
      timeoutMs: 15_000,
      graceMs: 2_000,
      now: () => Date.now() + skew,
    });
    const state = track(result);
    skew = 1_500; // the loop was stalled past the due time
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.error).toMatchObject({ name: 'DbPoolAcquireTimeoutError', timer: 'late' });
    expect(getDeadlineExpiryTotals().acquire).toEqual({ late: 1, 'on-time': 0 });
  });

  it('gives a late prologue timer one grace period and labels the expiry late', async () => {
    let skew = 0;
    const onExpired = vi.fn();
    const result = withAcquireAndPrologueDeadline(
      'x',
      (acquisition) => {
        acquisition.acquired();
        return new Promise<never>(() => {});
      },
      { acquireTimeoutMs: 1_000, timeoutMs: 1_000, graceMs: 2_000, onExpired, now: () => Date.now() + skew },
    );
    const state = track(result);
    skew = 1_500;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.error).toMatchObject({ name: 'DbAccessContextPrologueTimeoutError', timer: 'late' });
    expect(onExpired.mock.calls[0][0]).toMatchObject({ timer: 'late', timeoutMs: 1_000 });
  });

  it('a prologue that lands during the grace period wins', async () => {
    let skew = 0;
    let finishPrologue!: () => void;
    const result = withAcquireAndPrologueDeadline(
      'x',
      async (acquisition) => {
        const deadline = acquisition.acquired();
        await new Promise<void>((resolve) => { finishPrologue = resolve; });
        deadline.disarm();
        return 'ok';
      },
      { acquireTimeoutMs: 1_000, timeoutMs: 1_000, graceMs: 2_000, now: () => Date.now() + skew },
    );
    skew = 1_500;
    await vi.advanceTimersByTimeAsync(1_000);
    finishPrologue();
    await expect(result).resolves.toBe('ok');
    expect(getDeadlineExpiryTotals().prologue).toEqual({ late: 0, 'on-time': 0 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/db/prologueDeadline.acquire.test.ts`
Expected: FAIL — the default test (`expected 15000 to be 10000`) and the new `describe` (`getDeadlineExpiryTotals is not a function` / `signal` undefined).

- [ ] **Step 3: Implement**

Add, directly below #8243's module docstring:

```ts
import {
  armLagTolerantTimeout,
  type LagTolerantTimeoutHandle,
  type TimerLateness,
} from './lagTolerantTimeout';
```

Append to the module docstring (before its closing `*/`):

```ts
 *
 * #8143 ADDITIONS. Both clocks are lag-tolerant (`lagTolerantTimeout.ts`): a
 * timer that fires at least 1 s late gets one grace period, and every expiry
 * carries `timer: 'late' | 'on-time'`. `acquisition.signal` aborts at acquire
 * expiry so a request waiting in the admission gate (`poolAdmission.ts`) leaves
 * the queue and never reaches the driver. The acquire default is 10 s so the
 * default budgets stay under the agent's 30 s HTTP timeout.
```

Then replace everything from `function readDeadlineKnobMs` to the end of the file with:

```ts
/**
 * Shared parsing for the deadline knobs: garbage or negative falls back to the
 * knob's default, 0 is an explicit and honoured "off".
 */
function readDeadlineKnobMs(name: string, fallbackMs: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(raw) || raw < 0) return fallbackMs;
  // A sub-second budget would turn ordinary cross-AZ latency into a fault, so
  // anything positive below the floor is treated as a misconfiguration and
  // clamped rather than honoured. 0 remains an explicit, honoured "off".
  if (raw === 0) return 0;
  return Math.max(raw, 1_000);
}

/** Env knob, alongside `DB_POOL_MAX` / `DB_POOL_HEALTH_*`. 0 disables the bound. */
export function getDbAccessContextPrologueTimeoutMs(): number {
  return readDeadlineKnobMs('DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS', 15_000);
}

/**
 * #8229 — bound on waiting for a pooled connection (admission gate + driver
 * queue + `BEGIN`). 0 disables it. Default 10 s (#8143): acquire 10 + prologue
 * 15 + two 2 s graces = 29 s, under the agent's 30 s HTTP timeout.
 */
export function getDbPoolAcquireTimeoutMs(): number {
  return readDeadlineKnobMs('DB_POOL_ACQUIRE_TIMEOUT_MS', 10_000);
}

const lateSuffix = (timer: TimerLateness): string =>
  timer === 'late' ? '; the timer fired late, so the event loop was stalled' : '';

/**
 * The typed error the caller sees when the prologue budget expires. Distinct
 * from any driver error on purpose: a `CONNECTION_CLOSED` surfaced from the
 * abandoned transaction would tell an operator the database dropped us.
 */
export class DbAccessContextPrologueTimeoutError extends Error {
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly contextLabel: string;
  readonly timer: TimerLateness;

  constructor(input: {
    contextLabel: string;
    elapsedMs: number;
    timeoutMs: number;
    timer?: TimerLateness;
    cause?: unknown;
  }) {
    const timer = input.timer ?? 'on-time';
    super(
      `RLS GUC prologue for ${input.contextLabel} did not complete within ${input.timeoutMs}ms `
        + `(elapsed ${input.elapsedMs}ms${lateSuffix(timer)}). The transaction was abandoned and will roll back; `
        + 'its pool permit returns when it settles, or after a wedged-backend reclaim; see '
        + '[db-prologue-deadline] / [db-wedged-backend] logs (#6048, #8143).',
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = 'DbAccessContextPrologueTimeoutError';
    this.elapsedMs = input.elapsedMs;
    this.timeoutMs = input.timeoutMs;
    this.contextLabel = input.contextLabel;
    this.timer = timer;
  }
}

/**
 * Thrown by {@link PrologueDeadline.throwIfAborted} after expiry, and by
 * `PoolSlot.throwIfAbandoned` before COMMIT. Never reaches the caller (the race
 * has already settled); it stops the opener from carrying on, or committing,
 * on a transaction we have given up on.
 */
export class DbAccessContextPrologueAbortedError extends Error {
  constructor(contextLabel: string) {
    super(
      `RLS GUC prologue for ${contextLabel} was aborted after its deadline expired; `
        + 'the opener will not proceed on this connection (#6048).',
    );
    this.name = 'DbAccessContextPrologueAbortedError';
  }
}

/**
 * #8229 — no connection within the acquire budget. Deliberately NOT a subclass
 * of {@link DbAccessContextPrologueTimeoutError}: this is saturation, not a
 * wedge. No reclamation pass is requested.
 */
export class DbPoolAcquireTimeoutError extends Error {
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly contextLabel: string;
  readonly timer: TimerLateness;

  constructor(input: { contextLabel: string; elapsedMs: number; timeoutMs: number; timer?: TimerLateness }) {
    const timer = input.timer ?? 'on-time';
    super(
      `Timed out waiting for a pooled database connection for ${input.contextLabel} after `
        + `${input.timeoutMs}ms (elapsed ${input.elapsedMs}ms${lateSuffix(timer)}). Every pool slot was busy (or the `
        + 'event loop was starved); this is saturation, not a wedged prologue, so no reclamation '
        + 'was requested. A request still waiting for a permit never reaches the driver; a connection '
        + 'handed over late is released unused (#8229, #8143).',
    );
    this.name = 'DbPoolAcquireTimeoutError';
    this.elapsedMs = input.elapsedMs;
    this.timeoutMs = input.timeoutMs;
    this.contextLabel = input.contextLabel;
    this.timer = timer;
  }
}

/**
 * Thrown by {@link PoolAcquisition.acquired} when the pool hands over a
 * connection AFTER the acquire budget expired; never reaches the caller.
 * Throwing it from the transaction callback makes the driver roll back and
 * return the connection before anything is issued on it.
 */
export class DbPoolAcquireAbortedError extends Error {
  constructor(contextLabel: string) {
    super(
      `Pooled connection for ${contextLabel} arrived after the acquire budget expired; `
        + 'releasing it unused (#8229).',
    );
    this.name = 'DbPoolAcquireAbortedError';
  }
}

export interface PrologueDeadline {
  /** True once the budget expired. */
  readonly aborted: boolean;
  /** Throws {@link DbAccessContextPrologueAbortedError} once aborted. */
  throwIfAborted(): void;
  /** Stop the clock. Idempotent; called as soon as the prologue completes. */
  disarm(): void;
}

/** A deadline that never fires, for the disabled path. Allocation-free. */
const UNBOUNDED_DEADLINE: PrologueDeadline = {
  aborted: false,
  throwIfAborted() {},
  disarm() {},
};

export interface PrologueDeadlineExpiry {
  contextLabel: string;
  elapsedMs: number;
  timeoutMs: number;
  /** 'late' when the timer callback ran at least 1 s after its due time. */
  timer: TimerLateness;
}

export interface WithPrologueDeadlineDeps {
  timeoutMs?: number;
  /**
   * Fired synchronously at expiry, BEFORE the typed error is thrown, so caller
   * latency is bounded by the deadline rather than by recovery. Must not throw.
   */
  onExpired?: (expiry: PrologueDeadlineExpiry) => void;
  now?: () => number;
  /** Defaults to getDbTimerLagGraceMs(). */
  graceMs?: number;
}

export type DeadlineClock = 'acquire' | 'prologue';

const expiryTotals: Record<DeadlineClock, Record<TimerLateness, number>> = {
  acquire: { late: 0, 'on-time': 0 },
  prologue: { late: 0, 'on-time': 0 },
};

/** Expiries in this process, per clock and timer lateness. Monotonic. */
export function getDeadlineExpiryTotals(): Record<DeadlineClock, Record<TimerLateness, number>> {
  return { acquire: { ...expiryTotals.acquire }, prologue: { ...expiryTotals.prologue } };
}

export function __resetDeadlineExpiryTotalsForTests(): void {
  for (const clock of ['acquire', 'prologue'] as const) {
    expiryTotals[clock].late = 0;
    expiryTotals[clock]['on-time'] = 0;
  }
}

/**
 * Run `work` under a prologue deadline whose clock starts NOW, for a prologue
 * on a connection the caller already holds (`withResolvedDbAccessContext`'s
 * narrowing prologue). `work` MUST call `disarm()` the moment the prologue is
 * done.
 */
export async function withPrologueDeadline<T>(
  contextLabel: string,
  work: (deadline: PrologueDeadline) => Promise<T>,
  deps: WithPrologueDeadlineDeps = {},
): Promise<T> {
  return withAcquireAndPrologueDeadline(
    contextLabel,
    (acquisition) => work(acquisition.acquired()),
    { ...deps, acquireTimeoutMs: 0 },
  );
}

/**
 * Handed to a pooled-connection opener's `work`. The transaction callback MUST
 * call `acquired()` as its very first statement, before issuing anything.
 */
export interface PoolAcquisition {
  /**
   * Stops the acquire clock and starts the prologue clock, returning the
   * prologue deadline. Throws {@link DbPoolAcquireAbortedError} if the acquire
   * budget already expired. Idempotent otherwise.
   */
  acquired(): PrologueDeadline;
  /**
   * Aborts at acquire expiry (#8143). The admission gate listens to it so a
   * request still waiting for a permit leaves the queue instead of later
   * spending a connection on BEGIN + ROLLBACK. Never aborts after acquired().
   */
  readonly signal: AbortSignal;
}

const NEVER_ABORTED: AbortSignal = new AbortController().signal;

const UNBOUNDED_ACQUISITION: PoolAcquisition = {
  acquired: () => UNBOUNDED_DEADLINE,
  signal: NEVER_ABORTED,
};

export interface WithAcquireAndPrologueDeadlineDeps extends WithPrologueDeadlineDeps {
  /** Pool-acquire budget; defaults to {@link getDbPoolAcquireTimeoutMs}. 0 = unbounded. */
  acquireTimeoutMs?: number;
  /**
   * Fired synchronously at ACQUIRE expiry, before the typed error is thrown;
   * observability only. Never requests a reclaim. Must not throw.
   */
  onAcquireExpired?: (expiry: PrologueDeadlineExpiry) => void;
}

/**
 * Run a pooled-connection opener under two consecutive, independent,
 * lag-tolerant budgets (#8229, #8143):
 *
 * 1. ACQUIRE: from now until `work` calls `acquisition.acquired()`. Expiry
 *    rejects with {@link DbPoolAcquireTimeoutError}, then aborts
 *    `acquisition.signal`, then calls `onAcquireExpired`. No reclaim.
 * 2. PROLOGUE: from `acquired()` until the returned deadline is disarmed.
 *    Expiry calls `onExpired`, then rejects with
 *    {@link DbAccessContextPrologueTimeoutError}.
 *
 * Both expiries settle the caller's promise from OUTSIDE the transaction, by
 * racing it, never by throwing inside the callback.
 */
export async function withAcquireAndPrologueDeadline<T>(
  contextLabel: string,
  work: (acquisition: PoolAcquisition) => Promise<T>,
  deps: WithAcquireAndPrologueDeadlineDeps = {},
): Promise<T> {
  const acquireTimeoutMs = deps.acquireTimeoutMs ?? getDbPoolAcquireTimeoutMs();
  const prologueTimeoutMs = deps.timeoutMs ?? getDbAccessContextPrologueTimeoutMs();
  if (acquireTimeoutMs <= 0 && prologueTimeoutMs <= 0) return work(UNBOUNDED_ACQUISITION);

  const now = deps.now ?? Date.now;
  let acquireHandle: LagTolerantTimeoutHandle | undefined;
  let prologueHandle: LagTolerantTimeoutHandle | undefined;
  let acquireExpired = false;
  let prologueAborted = false;
  let deadline: PrologueDeadline | undefined;
  const acquireAbort = new AbortController();

  let fail!: (err: Error) => void;
  const expiry = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });

  const stopAcquireClock = (): void => {
    acquireHandle?.cancel();
    acquireHandle = undefined;
  };
  const disarmPrologue = (): void => {
    prologueHandle?.cancel();
    prologueHandle = undefined;
  };

  if (acquireTimeoutMs > 0) {
    acquireHandle = armLagTolerantTimeout({
      timeoutMs: acquireTimeoutMs,
      graceMs: deps.graceMs,
      now,
      onFire: ({ elapsedMs, late }) => {
        acquireHandle = undefined;
        acquireExpired = true;
        const timer: TimerLateness = late ? 'late' : 'on-time';
        expiryTotals.acquire[timer] += 1;
        // Settle the caller FIRST, then let a gate waiter leave its queue: the
        // waiter's own rejection must never win the race below.
        fail(new DbPoolAcquireTimeoutError({ contextLabel, elapsedMs, timeoutMs: acquireTimeoutMs, timer }));
        acquireAbort.abort();
        // Guarded: a reporting fault must not replace the caller's real error.
        try {
          deps.onAcquireExpired?.({ contextLabel, elapsedMs, timeoutMs: acquireTimeoutMs, timer });
        } catch (reportErr) {
          console.warn('[db-pool-acquire] expiry handler failed:', reportErr);
        }
      },
    });
  }

  const acquisition: PoolAcquisition = {
    signal: acquireAbort.signal,
    acquired() {
      // The caller has already been told we gave up. Refuse the connection so
      // the driver rolls back and returns it to the pool.
      if (acquireExpired) throw new DbPoolAcquireAbortedError(contextLabel);
      if (deadline) return deadline;
      stopAcquireClock();
      if (prologueTimeoutMs <= 0) {
        deadline = UNBOUNDED_DEADLINE;
        return deadline;
      }

      deadline = {
        get aborted() {
          return prologueAborted;
        },
        throwIfAborted() {
          if (prologueAborted) throw new DbAccessContextPrologueAbortedError(contextLabel);
        },
        disarm: disarmPrologue,
      };
      prologueHandle = armLagTolerantTimeout({
        timeoutMs: prologueTimeoutMs,
        graceMs: deps.graceMs,
        now,
        onFire: ({ elapsedMs, late }) => {
          prologueHandle = undefined;
          prologueAborted = true;
          const timer: TimerLateness = late ? 'late' : 'on-time';
          expiryTotals.prologue[timer] += 1;
          // Reported BEFORE the rejection and never awaited. Guarded because a
          // reporting fault must not replace the caller's real error.
          try {
            deps.onExpired?.({ contextLabel, elapsedMs, timeoutMs: prologueTimeoutMs, timer });
          } catch (reportErr) {
            console.warn('[db-prologue-deadline] expiry handler failed:', reportErr);
          }
          fail(new DbAccessContextPrologueTimeoutError({
            contextLabel,
            elapsedMs,
            timeoutMs: prologueTimeoutMs,
            timer,
          }));
        },
      });
      return deadline;
    },
  };

  try {
    // The race keeps the abandoned `work` promise subscribed, so its eventual
    // rejection (CONNECTION_CLOSED after a reclaim, DbPoolAcquireAbortedError for
    // a refused late connection, or the gate's cancellation) is handled.
    return await Promise.race([work(acquisition), expiry]);
  } finally {
    stopAcquireClock();
    disarmPrologue();
  }
}
```

Also update `db/index.ts`'s `onPoolAcquireExpired` parameter type from `{ contextLabel; elapsedMs; timeoutMs }` to `PrologueDeadlineExpiry` (import the type) and add `, timer ${expiry.timer}` to its warning text, so the throttled line says whether the loop was stalled.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run src/db/prologueDeadline.acquire.test.ts src/db/prologueDeadline.test.ts src/db/prologueDeadlineWiring.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit=$?"
```
Expected: all PASS (fake timers advance `Date.now` exactly, so #8243's existing tests never see a late timer); `tsc exit=0`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/prologueDeadline.ts apps/api/src/db/prologueDeadline.acquire.test.ts apps/api/src/db/index.ts
git commit -m "feat(db): lag-tolerant acquire/prologue clocks, acquisition.signal, expiry totals, 10s acquire default (#8143)"
```

---

### Task 3: Pool admission gate (runs inside #8243's acquire budget)

**Why it is still needed with #8243.** #8243 bounds the wait and refuses a late connection, but a request that has already failed stays queued inside postgres.js and later still costs a real connection a `BEGIN` + `ROLLBACK`, ahead of live requests (root-cause item 3). It also cannot report in-use/waiting (the driver keeps its queues in closure scope), cannot tell an escalation from a fresh request (item: nested hold-and-wait), and cannot keep a permit held by an abandoned transaction out of circulation in a way metrics can see. The gate does those four things and nothing else; it owns no timer.

**Files:**
- Create: `apps/api/src/db/poolAdmission.ts`
- Test: `apps/api/src/db/poolAdmission.test.ts`

**Interfaces:**
- Consumes: `DbAccessContextPrologueAbortedError` (from `./prologueDeadline`).
- Produces:
  - `function nestedReserveFor(permits: number): number` (1 when permits ≥ 3, else 0)
  - `class DbPoolAdmissionCancelledError extends Error` (a waiter left the queue because its acquire budget expired; never reaches the caller)
  - `type PoolSlotSettlement = 'resolved' | 'rejected' | 'connection-closed'`; `function classifyPoolSlotSettlement(err: unknown): PoolSlotSettlement`
  - `type AbandonedReturnKind = 'rollback' | 'connection-closed'`; `const ABANDONED_RETURN_KINDS: readonly AbandonedReturnKind[]`
  - `interface PoolSlot { readonly id: number; readonly label: string; readonly nested: boolean; readonly abandoned: boolean; readonly released: boolean; readonly abandonment: Promise<never>; abandon(reason: Error): void; throwIfAbandoned(): void; release(settlement: PoolSlotSettlement): void }`
  - `interface PoolAdmissionSnapshot { permits: number; nestedReserve: number; inUse: number; waiting: number; abandoned: number; effectivePermits: number }`
  - `interface PoolAdmissionTotals { abandoned: number; abandonedReturned: Record<AbandonedReturnKind, number>; cancelledWaiters: number }`
  - `interface PoolAdmission { acquire(label: string, options?: { nested?: boolean; signal?: AbortSignal }): Promise<PoolSlot>; snapshot(): PoolAdmissionSnapshot; totals(): PoolAdmissionTotals }`
  - `function createPoolAdmission(input: { permits: number; nestedReserve?: number }): PoolAdmission`
  - `function registerRequestPoolAdmission(admission: PoolAdmission): void`, `function getRequestPoolAdmission(): PoolAdmission | null`, `function __resetRequestPoolAdmissionForTests(): void`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/db/poolAdmission.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyPoolSlotSettlement,
  createPoolAdmission,
  DbPoolAdmissionCancelledError,
  getRequestPoolAdmission,
  nestedReserveFor,
  registerRequestPoolAdmission,
  __resetRequestPoolAdmissionForTests,
  type PoolSlot,
} from './poolAdmission';
import { DbAccessContextPrologueAbortedError } from './prologueDeadline';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('nestedReserveFor', () => {
  it('reserves one permit for nested escalations only when the pool can spare it', () => {
    expect(nestedReserveFor(1)).toBe(0);
    expect(nestedReserveFor(2)).toBe(0);
    expect(nestedReserveFor(3)).toBe(1);
    expect(nestedReserveFor(30)).toBe(1);
  });
});

describe('classifyPoolSlotSettlement', () => {
  it('recognises driver connection loss and server-side termination', () => {
    expect(classifyPoolSlotSettlement(Object.assign(new Error('x'), { code: 'CONNECTION_CLOSED' }))).toBe('connection-closed');
    expect(classifyPoolSlotSettlement(Object.assign(new Error('x'), { code: 'CONNECTION_DESTROYED' }))).toBe('connection-closed');
    // pg_terminate_backend: the FATAL can reach the transaction before the socket close does.
    expect(classifyPoolSlotSettlement(Object.assign(new Error('terminating connection'), { code: '57P01' }))).toBe('connection-closed');
    expect(classifyPoolSlotSettlement(Object.assign(new Error('unique'), { code: '23505' }))).toBe('rejected');
    expect(classifyPoolSlotSettlement(new Error('boom'))).toBe('rejected');
    expect(classifyPoolSlotSettlement(undefined)).toBe('rejected');
  });
});

describe('createPoolAdmission', () => {
  it('grants immediately below the top-level cap and counts in-use', async () => {
    const gate = createPoolAdmission({ permits: 3 });
    const a = await gate.acquire('t');
    const b = await gate.acquire('t');
    expect(gate.snapshot()).toEqual({ permits: 3, nestedReserve: 1, inUse: 2, waiting: 0, abandoned: 0, effectivePermits: 3 });
    a.release('resolved');
    b.release('resolved');
    expect(gate.snapshot().inUse).toBe(0);
  });

  it('keeps top-level acquirers out of the nested reserve', async () => {
    const gate = createPoolAdmission({ permits: 3 });
    await gate.acquire('t');
    await gate.acquire('t');
    let third: PoolSlot | null = null;
    void gate.acquire('t').then((slot) => { third = slot; });
    await flush();
    expect(third).toBeNull();
    expect(gate.snapshot().waiting).toBe(1);
  });

  it('nested acquirers use the reserve and are served before top-level waiters', async () => {
    const gate = createPoolAdmission({ permits: 3 });
    const parentA = await gate.acquire('parent');
    await gate.acquire('parent');
    const order: string[] = [];
    void gate.acquire('top').then((slot) => { order.push('top'); return slot; });
    const nested = await gate.acquire('nested', { nested: true });
    order.push('nested');
    expect(nested.nested).toBe(true);
    expect(gate.snapshot().inUse).toBe(3);
    nested.release('resolved');
    await flush();
    // The freed permit is the reserve: the top-level waiter still cannot take it.
    expect(order).toEqual(['nested']);
    parentA.release('resolved');
    await flush();
    expect(order).toEqual(['nested', 'top']);
  });

  it('a waiter whose signal aborts leaves the queue and is never granted', async () => {
    const gate = createPoolAdmission({ permits: 1 });
    const holder = await gate.acquire('holder');
    const controller = new AbortController();
    const waiting = gate.acquire('waiter', { signal: controller.signal });
    const assertion = expect(waiting).rejects.toBeInstanceOf(DbPoolAdmissionCancelledError);
    controller.abort();
    await assertion;
    expect(gate.snapshot()).toMatchObject({ inUse: 1, waiting: 0 });
    expect(gate.totals().cancelledWaiters).toBe(1);
    holder.release('resolved');
    expect(gate.snapshot()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('an already-aborted signal is refused without queueing', async () => {
    const gate = createPoolAdmission({ permits: 1 });
    await gate.acquire('holder');
    const controller = new AbortController();
    controller.abort();
    await expect(gate.acquire('late', { signal: controller.signal })).rejects.toBeInstanceOf(DbPoolAdmissionCancelledError);
    expect(gate.snapshot().waiting).toBe(0);
  });

  it('a granted waiter stops listening, so a later abort cannot cancel its permit', async () => {
    const gate = createPoolAdmission({ permits: 1 });
    const holder = await gate.acquire('holder');
    const controller = new AbortController();
    const waiting = gate.acquire('waiter', { signal: controller.signal });
    holder.release('resolved');
    const slot = await waiting;
    controller.abort();
    await flush();
    expect(slot.released).toBe(false);
    expect(gate.snapshot()).toMatchObject({ inUse: 1, waiting: 0 });
    expect(gate.totals().cancelledWaiters).toBe(0);
  });

  it('an abandoned permit is never re-admitted until its transaction settles', async () => {
    const gate = createPoolAdmission({ permits: 1 });
    const slot = await gate.acquire('t');
    const abandonment = expect(slot.abandonment).rejects.toThrow('prologue expired');
    slot.abandon(new Error('prologue expired'));
    await abandonment;
    expect(gate.snapshot()).toMatchObject({ inUse: 1, abandoned: 1, effectivePermits: 0 });
    let next: PoolSlot | null = null;
    void gate.acquire('t').then((granted) => { next = granted; });
    await flush();
    expect(next).toBeNull();
    slot.release('connection-closed');
    await flush();
    expect(next).not.toBeNull();
    expect(gate.snapshot()).toMatchObject({ inUse: 1, abandoned: 0, effectivePermits: 1 });
    expect(gate.totals()).toMatchObject({ abandoned: 1, abandonedReturned: { rollback: 0, 'connection-closed': 1 } });
  });

  it('abandon and release are idempotent', async () => {
    const gate = createPoolAdmission({ permits: 2 });
    const slot = await gate.acquire('t');
    slot.abandon(new Error('a'));
    slot.abandon(new Error('b'));
    slot.release('rejected');
    slot.release('rejected');
    slot.abandon(new Error('after release'));
    expect(gate.snapshot()).toMatchObject({ inUse: 0, abandoned: 0 });
    expect(gate.totals()).toMatchObject({ abandoned: 1, abandonedReturned: { rollback: 1, 'connection-closed': 0 } });
  });

  it('throwIfAbandoned throws the aborted error only once abandoned', async () => {
    const gate = createPoolAdmission({ permits: 2 });
    const slot = await gate.acquire('withDbAccessContext(scope=system)');
    expect(() => slot.throwIfAbandoned()).not.toThrow();
    slot.abandon(new Error('expired'));
    expect(() => slot.throwIfAbandoned()).toThrow(DbAccessContextPrologueAbortedError);
  });

  it('an un-awaited abandonment never becomes an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const gate = createPoolAdmission({ permits: 2 });
      const slot = await gate.acquire('t');
      slot.abandon(new Error('nobody is racing this'));
      await flush();
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('request pool admission registry', () => {
  afterEach(() => {
    __resetRequestPoolAdmissionForTests();
  });

  it('is null until the db module registers its gate', () => {
    expect(getRequestPoolAdmission()).toBeNull();
    const gate = createPoolAdmission({ permits: 4 });
    registerRequestPoolAdmission(gate);
    expect(getRequestPoolAdmission()).toBe(gate);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/db/poolAdmission.test.ts`
Expected: FAIL — `Failed to resolve import "./poolAdmission"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/db/poolAdmission.ts
/**
 * Request-pool admission (#8143), running inside #8229's acquire budget.
 *
 * WHY A GATE IN FRONT OF postgres.js. The driver queues a `begin()` that finds
 * no free connection, and nothing reachable through drizzle can take it back
 * out. #8229 refuses a connection handed over after the acquire budget, but the
 * refused request still spent that connection on BEGIN + ROLLBACK, queued ahead
 * of live work. This gate keeps the queue in OUR hands: when the acquire budget
 * expires, `acquisition.signal` aborts and the waiter leaves here, before the
 * driver ever sees it. The gate owns no timer: the single acquire clock (and
 * knob, DB_POOL_ACQUIRE_TIMEOUT_MS) is #8229's.
 *
 * WHAT A PERMIT IS. One per outermost DB context, DB_POOL_MAX of them. NOT a
 * connection count: bare-pool queries are never reserved (the driver pipelines
 * them) and are not gated. Every series derived from this says "permits".
 *
 * WHEN A PERMIT RETURNS. When the underlying transaction promise settles, never
 * when the caller is answered. An abandoned transaction keeps its permit until
 * it rolls back or its connection is closed by the wedged-backend reclaimer, so
 * the gate never admits more transactions than the driver has connections.
 *
 * NESTED RESERVE. A request that holds a permit and opens a second context
 * (`runOutsideDbContext(() => withSystemDbAccessContext(...))`, the #1105
 * escalation) is NESTED. Top-level acquirers are capped at
 * `permits - nestedReserve`, nested waiters are served first, so a depth-1
 * escalation always finds a permit instead of waiting on its own parent.
 *
 * Leaf module: imports only prologueDeadline.
 */

import { DbAccessContextPrologueAbortedError } from './prologueDeadline';

/** One permit is kept for nested escalations once the pool can spare one. */
export function nestedReserveFor(permits: number): number {
  return permits >= 3 ? 1 : 0;
}

/**
 * A waiter left the queue because its acquire budget expired. Never reaches the
 * caller: #8229's race has already settled with DbPoolAcquireTimeoutError.
 */
export class DbPoolAdmissionCancelledError extends Error {
  constructor(contextLabel: string) {
    super(`${contextLabel} left the pool admission queue: its acquire budget expired (#8143).`);
    this.name = 'DbPoolAdmissionCancelledError';
  }
}

export interface PoolAdmissionSnapshot {
  permits: number;
  nestedReserve: number;
  inUse: number;
  waiting: number;
  /** Permits held by abandoned transactions that have not settled yet. */
  abandoned: number;
  /** permits - abandoned: what the gate can actually hand out. */
  effectivePermits: number;
}

export type AbandonedReturnKind = 'rollback' | 'connection-closed';

export const ABANDONED_RETURN_KINDS: readonly AbandonedReturnKind[] = ['rollback', 'connection-closed'];

export interface PoolAdmissionTotals {
  abandoned: number;
  abandonedReturned: Record<AbandonedReturnKind, number>;
  /** Waiters that left the queue at acquire expiry (requests that never reached the driver). */
  cancelledWaiters: number;
}

export type PoolSlotSettlement = 'resolved' | 'rejected' | 'connection-closed';

/** 57P01 admin_shutdown (pg_terminate_backend), 57P02 crash_shutdown, 57P03 cannot_connect_now. */
const SERVER_TERMINATION_CODES = new Set(['57P01', '57P02', '57P03']);

/**
 * postgres.js connection-loss errors carry `code: 'CONNECTION_*'`
 * (`postgres/src/errors.js` `connection()`); a reclaimed backend may surface the
 * server's FATAL 57P01 first. Anything else is an ordinary rejection after a
 * ROLLBACK.
 */
export function classifyPoolSlotSettlement(err: unknown): PoolSlotSettlement {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'string') return 'rejected';
  return code.startsWith('CONNECTION_') || SERVER_TERMINATION_CODES.has(code) ? 'connection-closed' : 'rejected';
}

export interface PoolSlot {
  readonly id: number;
  readonly label: string;
  readonly nested: boolean;
  readonly abandoned: boolean;
  readonly released: boolean;
  /**
   * Rejects with the abandon reason the moment the slot is abandoned. Openers
   * race it so ANY prologue on this connection releases the CALLER at once,
   * even when the transaction cannot settle yet. Pre-caught.
   */
  readonly abandonment: Promise<never>;
  /** Idempotent; ignored after release. */
  abandon(reason: Error): void;
  /** Throws DbAccessContextPrologueAbortedError once abandoned. Call before COMMIT. */
  throwIfAbandoned(): void;
  /** Idempotent. Call exactly when the underlying transaction promise settles. */
  release(settlement: PoolSlotSettlement): void;
}

export interface AcquireOptions {
  nested?: boolean;
  /** #8229's `acquisition.signal`: aborting it removes the waiter. */
  signal?: AbortSignal;
}

export interface PoolAdmission {
  acquire(label: string, options?: AcquireOptions): Promise<PoolSlot>;
  snapshot(): PoolAdmissionSnapshot;
  totals(): PoolAdmissionTotals;
}

interface Waiter {
  label: string;
  nested: boolean;
  resolve: (slot: PoolSlot) => void;
  detach: () => void;
}

export function createPoolAdmission(input: { permits: number; nestedReserve?: number }): PoolAdmission {
  const permits = input.permits;
  const nestedReserve = input.nestedReserve ?? nestedReserveFor(permits);
  const topWaiters: Waiter[] = [];
  const nestedWaiters: Waiter[] = [];
  let inUse = 0;
  let abandonedCount = 0;
  let nextId = 1;
  const totals: PoolAdmissionTotals = {
    abandoned: 0,
    abandonedReturned: { rollback: 0, 'connection-closed': 0 },
    cancelledWaiters: 0,
  };

  const canGrant = (nested: boolean): boolean =>
    nested ? inUse < permits : inUse < permits - nestedReserve;

  const snapshot = (): PoolAdmissionSnapshot => ({
    permits,
    nestedReserve,
    inUse,
    waiting: topWaiters.length + nestedWaiters.length,
    abandoned: abandonedCount,
    effectivePermits: permits - abandonedCount,
  });

  function makeSlot(label: string, nested: boolean): PoolSlot {
    inUse += 1;
    let isAbandoned = false;
    let isReleased = false;
    let rejectAbandonment!: (reason: Error) => void;
    const abandonment = new Promise<never>((_resolve, reject) => {
      rejectAbandonment = reject;
    });
    abandonment.catch(() => {});

    return {
      id: nextId++,
      label,
      nested,
      get abandoned() {
        return isAbandoned;
      },
      get released() {
        return isReleased;
      },
      abandonment,
      abandon(reason: Error) {
        if (isAbandoned || isReleased) return;
        isAbandoned = true;
        abandonedCount += 1;
        totals.abandoned += 1;
        rejectAbandonment(reason);
      },
      throwIfAbandoned() {
        if (isAbandoned) throw new DbAccessContextPrologueAbortedError(label);
      },
      release(settlement: PoolSlotSettlement) {
        if (isReleased) return;
        isReleased = true;
        inUse -= 1;
        if (isAbandoned) {
          abandonedCount -= 1;
          totals.abandonedReturned[settlement === 'connection-closed' ? 'connection-closed' : 'rollback'] += 1;
        }
        drain();
      },
    };
  }

  function drain(): void {
    for (;;) {
      let waiter: Waiter | undefined;
      if (nestedWaiters.length > 0 && canGrant(true)) waiter = nestedWaiters.shift();
      else if (topWaiters.length > 0 && canGrant(false)) waiter = topWaiters.shift();
      if (!waiter) return;
      // Detach BEFORE resolving: a granted waiter can never also be cancelled.
      waiter.detach();
      waiter.resolve(makeSlot(waiter.label, waiter.nested));
    }
  }

  function acquire(label: string, options: AcquireOptions = {}): Promise<PoolSlot> {
    const nested = options.nested === true;
    const signal = options.signal;
    if (signal?.aborted) {
      totals.cancelledWaiters += 1;
      return Promise.reject(new DbPoolAdmissionCancelledError(label));
    }
    const queue = nested ? nestedWaiters : topWaiters;
    // Fast path only when nobody that should go first is already waiting.
    const nobodyAhead = nested
      ? nestedWaiters.length === 0
      : nestedWaiters.length === 0 && topWaiters.length === 0;
    if (nobodyAhead && canGrant(nested)) return Promise.resolve(makeSlot(label, nested));

    return new Promise<PoolSlot>((resolve, reject) => {
      const onAbort = (): void => {
        const index = queue.indexOf(waiter);
        if (index === -1) return;
        queue.splice(index, 1);
        totals.cancelledWaiters += 1;
        reject(new DbPoolAdmissionCancelledError(label));
      };
      const waiter: Waiter = {
        label,
        nested,
        resolve,
        detach: () => signal?.removeEventListener('abort', onAbort),
      };
      queue.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  return {
    acquire,
    snapshot,
    totals: () => ({
      abandoned: totals.abandoned,
      abandonedReturned: { ...totals.abandonedReturned },
      cancelledWaiters: totals.cancelledWaiters,
    }),
  };
}

// --- process registry -------------------------------------------------------
// `db/index.ts` registers the request pool's gate at module load. Read it from
// here (not through db/index) so metricsRuntime stays a leaf importer.

let requestPoolAdmission: PoolAdmission | null = null;

export function registerRequestPoolAdmission(admission: PoolAdmission): void {
  requestPoolAdmission = admission;
}

export function getRequestPoolAdmission(): PoolAdmission | null {
  return requestPoolAdmission;
}

export function __resetRequestPoolAdmissionForTests(): void {
  requestPoolAdmission = null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/db/poolAdmission.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/poolAdmission.ts apps/api/src/db/poolAdmission.test.ts
git commit -m "feat(db): request-pool admission gate with nested reserve and abandoned-permit accounting (#8143)"
```

---

### Task 4: Abandoned-permit reclaim scheduler

**Files:**
- Create: `apps/api/src/db/abandonedSlotReclaim.ts`
- Test: `apps/api/src/db/abandonedSlotReclaim.test.ts`

**Interfaces:**
- Consumes: Task 3 `createPoolAdmission`, `type PoolSlot`; existing `requestWedgedBackendReclaim`, `getWedgedBackendReclaimMinIntervalMs`, `type WedgedBackendReclaimOutcome` (`./wedgedBackends`); existing `claimDbPoolHealthCaptureSlot`, `getDbPoolHealthCaptureThrottleMs` (`./dbPoolHealthMonitor`); `captureMessage` (`../services/sentry`).
- Produces:
  - `const ABANDONED_SLOT_RECLAIM_MARGIN_MS = 1000`
  - `function reportReclaimOutcome(pass: Promise<WedgedBackendReclaimOutcome>): void` (moved verbatim in behaviour from `index.ts:559-600`)
  - `interface AbandonedSlotReclaimScheduler { track(slot: PoolSlot, prologueTimeoutMs: number): void; trackedCount(): number; stop(): void }`
  - `function createAbandonedSlotReclaimScheduler(deps?: { requestReclaim?: (deps: { minAgeMs: number }) => Promise<WedgedBackendReclaimOutcome> | null; report?: (pass: Promise<WedgedBackendReclaimOutcome>) => void; retryIntervalMs?: () => number; now?: () => number; warn?: (line: string) => void }): AbandonedSlotReclaimScheduler`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/db/abandonedSlotReclaim.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { captureMessage } = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureMessage }));

import {
  ABANDONED_SLOT_RECLAIM_MARGIN_MS,
  createAbandonedSlotReclaimScheduler,
  reportReclaimOutcome,
} from './abandonedSlotReclaim';
import { createPoolAdmission, type PoolSlot } from './poolAdmission';
import { __resetDbPoolHealthMonitorForTests } from './dbPoolHealthMonitor';
import type { WedgedBackendReclaimOutcome } from './wedgedBackends';

const OUTCOME: WedgedBackendReclaimOutcome = {
  scanned: 1, confirmed: 1, terminated: [4242], cappedAt: null, error: null, elapsedMs: 12,
};

async function abandonedSlot(permits = 8): Promise<PoolSlot> {
  const slot = await createPoolAdmission({ permits }).acquire('withDbAccessContext(scope=system)');
  slot.abandon(new Error('prologue expired'));
  return slot;
}

describe('createAbandonedSlotReclaimScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not ask for a pass before the backend can be old enough to match', async () => {
    const requestReclaim = vi.fn(() => Promise.resolve(OUTCOME));
    const scheduler = createAbandonedSlotReclaimScheduler({ requestReclaim, report: vi.fn(), retryIntervalMs: () => 60_000 });
    scheduler.track(await abandonedSlot(), 15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(requestReclaim).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ABANDONED_SLOT_RECLAIM_MARGIN_MS + 1_000);
    expect(requestReclaim).toHaveBeenCalledTimes(1);
    expect(requestReclaim).toHaveBeenCalledWith({ minAgeMs: 15_000 });
    scheduler.stop();
  });

  it('never asks when the permit came back on its own (the loop-stall / slow-DB case)', async () => {
    const requestReclaim = vi.fn(() => Promise.resolve(OUTCOME));
    const scheduler = createAbandonedSlotReclaimScheduler({ requestReclaim, report: vi.fn(), retryIntervalMs: () => 60_000 });
    const slot = await abandonedSlot();
    scheduler.track(slot, 15_000);
    await vi.advanceTimersByTimeAsync(3_000);
    slot.release('rejected');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requestReclaim).not.toHaveBeenCalled();
    expect(scheduler.trackedCount()).toBe(0);
  });

  it('retries at the reclaim floor while a permit is still held, and stops once it returns', async () => {
    const requestReclaim = vi.fn(() => Promise.resolve(OUTCOME));
    const scheduler = createAbandonedSlotReclaimScheduler({ requestReclaim, report: vi.fn(), retryIntervalMs: () => 10_000 });
    const slot = await abandonedSlot();
    scheduler.track(slot, 1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(requestReclaim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requestReclaim).toHaveBeenCalledTimes(2);
    slot.release('connection-closed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requestReclaim).toHaveBeenCalledTimes(2);
  });

  it('keeps going when more permits are wedged than one pass may terminate', async () => {
    const requestReclaim = vi.fn(() => Promise.resolve(OUTCOME));
    const scheduler = createAbandonedSlotReclaimScheduler({ requestReclaim, report: vi.fn(), retryIntervalMs: () => 5_000 });
    const slots = await Promise.all(Array.from({ length: 6 }, () => abandonedSlot(10)));
    for (const slot of slots) scheduler.track(slot, 1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(requestReclaim).toHaveBeenCalledTimes(1);
    for (const slot of slots.slice(0, 4)) slot.release('connection-closed');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestReclaim).toHaveBeenCalledTimes(2);
    for (const slot of slots.slice(4)) slot.release('connection-closed');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requestReclaim).toHaveBeenCalledTimes(2);
  });

  it('asks with the smallest prologue budget among the due permits', async () => {
    const requestReclaim = vi.fn(() => Promise.resolve(OUTCOME));
    const scheduler = createAbandonedSlotReclaimScheduler({ requestReclaim, report: vi.fn(), retryIntervalMs: () => 60_000 });
    scheduler.track(await abandonedSlot(), 2_000);
    scheduler.track(await abandonedSlot(), 1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestReclaim).toHaveBeenCalledWith({ minAgeMs: 1_000 });
    scheduler.stop();
  });

  it('declined reclaim (disabled or inside the floor) warns at the retry pace, not every tick', async () => {
    const warn = vi.fn();
    const requestReclaim = vi.fn(() => null);
    const scheduler = createAbandonedSlotReclaimScheduler({ requestReclaim, report: vi.fn(), warn, retryIntervalMs: () => 10_000 });
    scheduler.track(await abandonedSlot(), 1_000);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(requestReclaim).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0][0]).toContain('reclaim was declined');
    expect(warn.mock.calls[0][0]).toContain('#8143');
    scheduler.stop();
  });
});

describe('reportReclaimOutcome', () => {
  beforeEach(() => {
    captureMessage.mockReset();
    __resetDbPoolHealthMonitorForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a successful pass', async () => {
    reportReclaimOutcome(Promise.resolve(OUTCOME));
    await new Promise((resolve) => setImmediate(resolve));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('terminated=[4242]'));
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('reports a failed pass to Sentry, throttled', async () => {
    const failed = { ...OUTCOME, terminated: [], error: 'connect ECONNREFUSED' };
    reportReclaimOutcome(Promise.resolve(failed));
    reportReclaimOutcome(Promise.resolve(failed));
    await new Promise((resolve) => setImmediate(resolve));
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      '[db-wedged-backend] reclamation pass failed (#6048)',
      expect.objectContaining({ eventCode: 'db_wedged_backend_reclaim_failed' }),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/db/abandonedSlotReclaim.test.ts`
Expected: FAIL — `Failed to resolve import "./abandonedSlotReclaim"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/db/abandonedSlotReclaim.ts
/**
 * Deferred wedged-backend reclaim for abandoned pool permits (#8143).
 *
 * WHY DEFERRED. Before #8143 a reclaim pass was requested the instant a
 * prologue deadline expired, with `minAgeMs = timeoutMs`. The backend that
 * triggered it started its transaction AFTER the timer was armed, so it was
 * always younger than `minAgeMs` and that pass could never match it (216
 * passes, all `scanned=0`, on 2026-10-08). Most abandoned transactions need no
 * reclaim at all: the late statement completes, the opener's abort check
 * throws, postgres.js rolls back, and the permit returns on its own.
 *
 * WHAT THIS DOES. One scheduler watches every abandoned permit. A permit still
 * held `prologueTimeoutMs + ABANDONED_SLOT_RECLAIM_MARGIN_MS` after it was
 * abandoned is a wedge candidate: by then any `set_config` it sent is at least
 * `prologueTimeoutMs` old, so the existing reclaimer predicate can match it.
 * Requests are paced at the reclaim floor. Safety (two snapshots, cap of 4 per
 * pass, same-role only) stays entirely in `wedgedBackends.ts`.
 *
 * BOUND (conditional, stated honestly). First eligible pass at abandonment +
 * prologue budget + 1 s; then one pass per DB_WEDGED_BACKEND_RECLAIM_MIN_INTERVAL_MS,
 * each terminating at most DB_WEDGED_BACKEND_RECLAIM_MAX_PER_PASS backends;
 * the 5-minute scanner in dbPoolHealthMonitor stays as the backstop. With
 * reclaim disabled, the permit stays held and is reported, never re-admitted.
 */

import { captureMessage } from '../services/sentry';
import { claimDbPoolHealthCaptureSlot, getDbPoolHealthCaptureThrottleMs } from './dbPoolHealthMonitor';
import type { PoolSlot } from './poolAdmission';
import {
  getWedgedBackendReclaimMinIntervalMs,
  requestWedgedBackendReclaim,
  type WedgedBackendReclaimOutcome,
} from './wedgedBackends';

export const ABANDONED_SLOT_RECLAIM_MARGIN_MS = 1_000;

const TICK_MS = 1_000;

/**
 * Logs a pass outcome; a failed pass also goes to Sentry, throttled on its own
 * key. Moved unchanged in behaviour from db/index.ts (#6048). Never throws.
 */
export function reportReclaimOutcome(pass: Promise<WedgedBackendReclaimOutcome>): void {
  void pass
    .then((outcome) => {
      if (outcome.error) {
        console.warn('[db-wedged-backend] reclamation pass failed:', outcome.error);
        // Sentry too, not console only: a repair path broken for days while the
        // pool bleeds permits is the same invisible failure #6048 was filed for.
        // Throttled (this repo has twice blacked out Sentry with an unthrottled
        // recurring warning) and wrapped, because the reporter may be failing.
        if (
          claimDbPoolHealthCaptureSlot(
            'wedged-backend-reclaim-failed',
            Date.now(),
            getDbPoolHealthCaptureThrottleMs(),
          )
        ) {
          try {
            // Stable headline: Sentry groups by message.
            captureMessage('[db-wedged-backend] reclamation pass failed (#6048)', {
              eventCode: 'db_wedged_backend_reclaim_failed',
              tags: { db_pool_health_verdict: 'wedged-backend-reclaim-failed' },
            });
          } catch (captureErr) {
            console.error('[db-wedged-backend] failed to report reclaim failure to Sentry:', captureErr);
          }
        }
        return;
      }
      console.warn(
        `[db-wedged-backend] reclamation pass: scanned=${outcome.scanned} `
          + `confirmed=${outcome.confirmed} terminated=[${outcome.terminated.join(',')}] `
          + `cappedAt=${outcome.cappedAt ?? 'none'} in ${outcome.elapsedMs}ms.`,
      );
    })
    .catch((err: unknown) => {
      console.warn('[db-wedged-backend] reclamation pass threw unexpectedly:', err);
    });
}

export interface AbandonedSlotReclaimSchedulerDeps {
  requestReclaim?: (deps: { minAgeMs: number }) => Promise<WedgedBackendReclaimOutcome> | null;
  report?: (pass: Promise<WedgedBackendReclaimOutcome>) => void;
  retryIntervalMs?: () => number;
  now?: () => number;
  warn?: (line: string) => void;
}

export interface AbandonedSlotReclaimScheduler {
  /** Idempotent per slot; ignored once the slot is released. */
  track(slot: PoolSlot, prologueTimeoutMs: number): void;
  trackedCount(): number;
  stop(): void;
}

interface TrackedSlot {
  abandonedAt: number;
  eligibleAt: number;
  minAgeMs: number;
}

export function createAbandonedSlotReclaimScheduler(
  deps: AbandonedSlotReclaimSchedulerDeps = {},
): AbandonedSlotReclaimScheduler {
  const requestReclaim = deps.requestReclaim ?? ((reclaimDeps) => requestWedgedBackendReclaim(reclaimDeps));
  const report = deps.report ?? reportReclaimOutcome;
  const retryIntervalMs = deps.retryIntervalMs ?? getWedgedBackendReclaimMinIntervalMs;
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const tracked = new Map<PoolSlot, TrackedSlot>();
  let nextRequestAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule(): void {
    if (timer !== undefined || tracked.size === 0) return;
    timer = setTimeout(tick, TICK_MS);
    timer.unref?.();
  }

  function tick(): void {
    timer = undefined;
    const t = now();
    let due = 0;
    let minAgeMs = Number.POSITIVE_INFINITY;
    let oldestAbandonedAt = t;
    for (const [slot, entry] of tracked) {
      if (slot.released) {
        tracked.delete(slot);
        continue;
      }
      if (t >= entry.eligibleAt) {
        due += 1;
        minAgeMs = Math.min(minAgeMs, entry.minAgeMs);
        oldestAbandonedAt = Math.min(oldestAbandonedAt, entry.abandonedAt);
      }
    }
    if (due > 0 && t >= nextRequestAt) {
      const retryMs = retryIntervalMs();
      nextRequestAt = t + retryMs;
      try {
        const pass = requestReclaim({ minAgeMs });
        if (pass === null) {
          warn(
            `[db-pool-admission] ${due} abandoned transaction permit(s) still held (oldest abandoned `
              + `${Math.round((t - oldestAbandonedAt) / 1000)}s ago) and the wedged-backend reclaim was declined `
              + '(DB_WEDGED_BACKEND_RECLAIM_DISABLED, or inside its retry floor). The effective pool stays '
              + `reduced until they settle; retrying in ${Math.round(retryMs / 1000)}s (#8143).`,
          );
        } else {
          report(pass);
        }
      } catch (err) {
        warn(`[db-pool-admission] reclaim request threw: ${err instanceof Error ? err.message : String(err)} (#8143)`);
      }
    }
    schedule();
  }

  return {
    track(slot: PoolSlot, prologueTimeoutMs: number) {
      if (slot.released || tracked.has(slot)) return;
      const t = now();
      tracked.set(slot, {
        abandonedAt: t,
        eligibleAt: t + prologueTimeoutMs + ABANDONED_SLOT_RECLAIM_MARGIN_MS,
        minAgeMs: prologueTimeoutMs,
      });
      schedule();
    },
    trackedCount() {
      return tracked.size;
    },
    stop() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      tracked.clear();
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/db/abandonedSlotReclaim.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/abandonedSlotReclaim.ts apps/api/src/db/abandonedSlotReclaim.test.ts
git commit -m "feat(db): deferred wedged-backend reclaim for abandoned pool permits (#8143)"
```

---

### Task 5: postgres.js patch — BEGIN always reserves its connection

**Files:**
- Modify (via `pnpm patch`): `patches/postgres@3.4.9.patch`, `pnpm-lock.yaml` (patch hash)
- Test: `apps/api/src/__tests__/integration/postgresJsBeginReservation.integration.test.ts` (new)

**Interfaces:**
- Consumes: the vendored `postgres` package (ESM `src/` and CJS `cjs/src/` builds).
- Produces: patched `connection.js` `execute()` in `src/`, `cjs/src/`, `cf/src/`. No TypeScript API.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/__tests__/integration/postgresJsBeginReservation.integration.test.ts
/**
 * #8143 — postgres.js 3.4.9 `connection.js` execute():
 *
 *   return write(toBuffer(q)) && !q.describeFirst && !q.cursorFn
 *     && sent.length < max_pipeline
 *     && (!q.options.onexecute || q.options.onexecute(connection))
 *
 * `onexecute` is what reserves the connection for `sql.begin()`. When BEGIN is
 * pipelined behind another query at the pipeline limit (or hits write
 * backpressure) the && chain short-circuits, `begin()` rejects with
 * "Cannot set properties of undefined (setting 'onclose')", a TypeError escapes
 * unhandled, and the connection returns to the pool INSIDE the BEGIN: later
 * bare statements share one leaked transaction. Reproduced 2026-10-08 with
 * { max: 1, max_pipeline: 1 }. Production hits it via backpressure or 100
 * pipelined queries; the test forces it with max_pipeline: 1.
 *
 * Runs against BOTH builds (see postgresJsPoolPoisoning.test.ts for why).
 */
import { createRequire } from 'node:module';
import postgresEsm from 'postgres';
import { describe, expect, it } from 'vitest';

const postgresCjs = createRequire(import.meta.url)('postgres') as typeof postgresEsm;
const APP_URL = process.env.DATABASE_URL_APP;
const describeIf = APP_URL ? describe : describe.skip;

const DRIVER_BUILDS = [
  ['esm', postgresEsm],
  ['cjs', postgresCjs],
] as const;

describeIf.each(DRIVER_BUILDS)('postgres.js (%s): BEGIN pipelined behind a busy query', (_name, postgres) => {
  it('reserves its connection, so no transaction leaks back to the pool', async () => {
    const sql = postgres(APP_URL!, { max: 1, max_pipeline: 1 });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await sql`select 1`;
      const bare = sql`select pg_sleep(0.2), 1 as x`;
      bare.then(() => {}, () => {});
      // Let the bare query reach the only connection first.
      await new Promise((resolve) => setImmediate(resolve));
      const tx = sql.begin(async (t) => (await t`select 2 as y`)[0].y as number);

      const [bareResult, txResult] = await Promise.allSettled([bare, tx]);
      expect(bareResult.status).toBe('fulfilled');
      expect(txResult).toEqual({ status: 'fulfilled', value: 2 });

      // Two bare statements must be two transactions. A leaked BEGIN freezes now().
      const first = await sql`select now()::text as n`;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await sql`select now()::text as n`;
      expect(first[0].n).not.toBe(second[0].n);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await sql.end({ timeout: 1 });
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (repo root, then api):
```bash
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/postgresJsBeginReservation.integration.test.ts
```
Expected: FAIL on both builds — `txResult` is `{ status: 'rejected', reason: TypeError: Cannot set properties of undefined (setting 'onclose') }` (vitest may also report the unhandled `Cannot read properties of undefined (reading 'queue')`).

- [ ] **Step 3: Patch the driver**

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm patch postgres@3.4.9 --edit-dir /tmp/postgres-patch-8143
```
(pnpm applies the existing `patches/postgres@3.4.9.patch` into the edit dir; confirm with `grep -n "chunk = nextWriteTimer = null" /tmp/postgres-patch-8143/src/connection.js` — two hits expected. If there are none, stop: the existing #3225 hunks were not applied and committing would drop them.)

Apply the same replacement to all three builds:

```bash
python3 - /tmp/postgres-patch-8143 <<'EOF'
import sys, pathlib
root = pathlib.Path(sys.argv[1])
old = """      build(q)
      return write(toBuffer(q))
        && !q.describeFirst
        && !q.cursorFn
        && sent.length < max_pipeline
        && (!q.options.onexecute || q.options.onexecute(connection))"""
new = """      build(q)
      const accepted = write(toBuffer(q))
        && !q.describeFirst
        && !q.cursorFn
        && sent.length < max_pipeline
      // breeze patch (#8143): a transaction's BEGIN must reserve this
      // connection even when the write hit backpressure or the pipeline limit.
      // Upstream short-circuits past onexecute, so begin() ran with no
      // connection and this connection went back to the pool INSIDE the BEGIN.
      // Returning false matches the normal path (onexecute returns undefined),
      // so the caller parks the connection in `full` exactly as before.
      if (q.options.onexecute) {
        q.options.onexecute(connection)
        return false
      }
      return accepted"""
for rel in ("src/connection.js", "cjs/src/connection.js", "cf/src/connection.js"):
    p = root / rel
    s = p.read_text()
    assert s.count(old) == 1, f"{rel}: expected exactly one execute() block"
    p.write_text(s.replace(old, new))
    print("patched", rel)
EOF
pnpm patch-commit /tmp/postgres-patch-8143
```

Verify the regenerated patch kept the #3225 hunks and added the new ones:
```bash
grep -c "chunk = nextWriteTimer = null" patches/postgres@3.4.9.patch   # expect 6
grep -c "breeze patch (#8143)" patches/postgres@3.4.9.patch            # expect 3
git diff --stat -- patches/postgres@3.4.9.patch pnpm-lock.yaml
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/postgresJsBeginReservation.integration.test.ts
cd apps/api && npx vitest run src/db/postgresJsPoolPoisoning.test.ts
```
Expected: both PASS (the #3225 regression suite still green on both builds).

- [ ] **Step 5: Commit**

```bash
git add patches/postgres@3.4.9.patch pnpm-lock.yaml apps/api/src/__tests__/integration/postgresJsBeginReservation.integration.test.ts
git commit -m "fix(db): patch postgres.js so BEGIN always reserves its connection (#8143)"
```

---

### Task 6: Integration harness and acceptance suite (written RED against current wiring)

**Files:**
- Create: `apps/api/src/__tests__/integration/helpers/pgWireProxy.ts`
- Create: `apps/api/src/__tests__/integration/dbPoolRecovery.integration.test.ts`

**Interfaces:**
- Consumes (from the fresh `../../db` module, after Task 7): `withDbAccessContext`, `withSystemDbAccessContext`, `runOutsideDbContext`, `db`, `closeDb`, `getRequestPoolAdmission`, `getDeadlineExpiryTotals`, type `DbAccessContext`. Before Task 7 these two getters are not exported from `db/index.ts`; that is part of the expected RED. Error names come from #8243 (`DbPoolAcquireTimeoutError`) and main (`DbAccessContextPrologueTimeoutError`).
- Produces (test helper): `startPgWireProxy(target: { host: string; port: number }, options?: { holdApplicationName?: string }): Promise<PgWireProxy>` with `PgWireProxy { port; stats: { connections; begins; prologueExecutes }; urlFor(url: string): string; armWedgeOnNextPrologue(): void; armHoldResponsesAfterNextPrologue(): void; resume(): void; close(): Promise<void> }`.

- [ ] **Step 1: Write the wire proxy**

```ts
// apps/api/src/__tests__/integration/helpers/pgWireProxy.ts
/**
 * In-process Postgres wire proxy for the #8143 pool-recovery suite.
 *
 * It understands just enough of the frontend protocol to:
 *   - count simple-query BEGINs (postgres.js sends `begin` via `sql.unsafe`,
 *     i.e. a simple 'Q' message), so a test can prove an acquire-timed-out
 *     request never reached the driver;
 *   - recognise the RLS prologue (`select set_config('breeze.…`) by tracking
 *     Parse→Bind per statement name, then at its Execute either
 *       * withhold every later client→server byte on that connection: the
 *         backend has the Bind and sits `active` / `ClientRead` on the
 *         prologue forever, which is the #6048 wedge, or
 *       * withhold server→client bytes until resume(): a slow database whose
 *         reply arrives after the deadline.
 * Only connections whose startup `application_name` matches
 * `holdApplicationName` (default 'breeze-api') are ever held, so the
 * reclaimer's side clients pass straight through.
 */
import net from 'node:net';

const SSL_REQUEST_CODE = 80877103;
const GSSENC_REQUEST_CODE = 80877104;
const PROTOCOL_3 = 196608;
const PROLOGUE_PREFIX = "select set_config('breeze.";

export interface PgWireProxyStats {
  connections: number;
  begins: number;
  prologueExecutes: number;
}

export interface PgWireProxy {
  readonly port: number;
  readonly stats: PgWireProxyStats;
  urlFor(url: string): string;
  armWedgeOnNextPrologue(): void;
  armHoldResponsesAfterNextPrologue(): void;
  resume(): void;
  close(): Promise<void>;
}

interface FrontendMessage {
  /** null for untyped startup-phase messages. */
  type: string | null;
  raw: Buffer;
  body: Buffer;
}

function readCString(buf: Buffer, offset: number): [string, number] {
  const end = buf.indexOf(0, offset);
  if (end === -1) return [buf.toString('utf8', offset), buf.length];
  return [buf.toString('utf8', offset, end), end + 1];
}

function parseStartupApplicationName(body: Buffer): string | null {
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const [key, afterKey] = readCString(body, offset);
    const [value, afterValue] = readCString(body, afterKey);
    if (key === 'application_name') return value;
    offset = afterValue;
  }
  return null;
}

class FrontendParser {
  private buffer = Buffer.alloc(0);
  private startupPhase = true;

  constructor(private readonly onMessage: (message: FrontendMessage) => void) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.startupPhase) {
        if (this.buffer.length < 8) return;
        const length = this.buffer.readInt32BE(0);
        if (this.buffer.length < length) return;
        const raw = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        const code = raw.readInt32BE(4);
        if (code !== SSL_REQUEST_CODE && code !== GSSENC_REQUEST_CODE) this.startupPhase = false;
        this.onMessage({ type: null, raw, body: raw.subarray(8) });
        continue;
      }
      if (this.buffer.length < 5) return;
      const length = this.buffer.readInt32BE(1);
      if (this.buffer.length < 1 + length) return;
      const raw = this.buffer.subarray(0, 1 + length);
      this.buffer = this.buffer.subarray(1 + length);
      this.onMessage({ type: String.fromCharCode(raw[0]!), raw, body: raw.subarray(5) });
    }
  }
}

interface ProxiedConnection {
  client: net.Socket;
  upstream: net.Socket;
  applicationName: string | null;
  statements: Map<string, string>;
  lastBindIsPrologue: boolean;
  clientHeld: boolean;
  serverHeld: boolean;
  heldServerChunks: Buffer[];
}

export async function startPgWireProxy(
  target: { host: string; port: number },
  options: { holdApplicationName?: string } = {},
): Promise<PgWireProxy> {
  const holdApplicationName = options.holdApplicationName ?? 'breeze-api';
  const stats: PgWireProxyStats = { connections: 0, begins: 0, prologueExecutes: 0 };
  const connections = new Set<ProxiedConnection>();
  let wedgeArmed = false;
  let holdResponsesArmed = false;

  const isBegin = (query: string): boolean => /^\s*begin\b/i.test(query);

  function onFrontendMessage(conn: ProxiedConnection, message: FrontendMessage): void {
    if (conn.clientHeld) return; // wedged: the backend never sees another byte
    if (message.type === null) {
      if (message.raw.readInt32BE(4) === PROTOCOL_3) {
        conn.applicationName = parseStartupApplicationName(message.body);
      }
    } else if (message.type === 'Q') {
      const [query] = readCString(message.body, 0);
      if (isBegin(query)) stats.begins += 1;
    } else if (message.type === 'P') {
      const [name, next] = readCString(message.body, 0);
      const [query] = readCString(message.body, next);
      conn.statements.set(name, query);
    } else if (message.type === 'B') {
      const [, next] = readCString(message.body, 0);
      const [statement] = readCString(message.body, next);
      conn.lastBindIsPrologue = (conn.statements.get(statement) ?? '').startsWith(PROLOGUE_PREFIX);
    } else if (message.type === 'E' && conn.lastBindIsPrologue) {
      stats.prologueExecutes += 1;
      if (conn.applicationName === holdApplicationName) {
        if (wedgeArmed) {
          wedgeArmed = false;
          conn.clientHeld = true;
          return;
        }
        if (holdResponsesArmed) {
          holdResponsesArmed = false;
          conn.serverHeld = true;
        }
      }
    }
    conn.upstream.write(message.raw);
  }

  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    const conn: ProxiedConnection = {
      client,
      upstream,
      applicationName: null,
      statements: new Map(),
      lastBindIsPrologue: false,
      clientHeld: false,
      serverHeld: false,
      heldServerChunks: [],
    };
    connections.add(conn);
    stats.connections += 1;
    const parser = new FrontendParser((message) => onFrontendMessage(conn, message));
    client.on('data', (chunk: Buffer) => parser.push(chunk));
    upstream.on('data', (chunk: Buffer) => {
      if (conn.serverHeld) conn.heldServerChunks.push(chunk);
      else client.write(chunk);
    });
    const teardown = (): void => {
      client.destroy();
      upstream.destroy();
      connections.delete(conn);
    };
    client.on('close', teardown);
    upstream.on('close', teardown);
    client.on('error', () => {});
    upstream.on('error', () => {});
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    stats,
    urlFor(url: string): string {
      const parsed = new URL(url);
      parsed.hostname = '127.0.0.1';
      parsed.port = String(port);
      return parsed.toString();
    },
    armWedgeOnNextPrologue() {
      wedgeArmed = true;
    },
    armHoldResponsesAfterNextPrologue() {
      holdResponsesArmed = true;
    },
    resume() {
      for (const conn of connections) {
        if (!conn.serverHeld) continue;
        conn.serverHeld = false;
        for (const chunk of conn.heldServerChunks.splice(0)) conn.client.write(chunk);
      }
    },
    async close() {
      for (const conn of connections) {
        conn.client.destroy();
        conn.upstream.destroy();
      }
      connections.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
```

- [ ] **Step 2: Write the acceptance suite**

```ts
// apps/api/src/__tests__/integration/dbPoolRecovery.integration.test.ts
/**
 * #8143 (W04 / spec W1e) — pool recovery against real Postgres.
 *
 * Each test imports a FRESH `db` module (own pool, own DB_POOL_MAX, own
 * timeouts) so it can size the pool down to 1–3 and make every assertion
 * deterministic. Acceptance from the spec: after a slow-event-loop stall the
 * pool is back at max within 30 s, with no leaked connection and no double use.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { sql } from 'drizzle-orm';
import { startPgWireProxy, type PgWireProxy } from './helpers/pgWireProxy';

type DbModule = typeof import('../../db');

const APP_URL = process.env.DATABASE_URL_APP;
const describeIf = APP_URL ? describe : describe.skip;
const ORIGINAL_ENV = { ...process.env };
const ORG = '5b0f3c1e-8d2a-4f6b-9c3e-1a2b3c4d5e6f';

let admin: Sql;
let current: DbModule | null = null;
let proxy: PgWireProxy | null = null;

function busyWait(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // deliberately stalling the event loop
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    await sleep(100);
  }
}

async function loadFreshDb(env: Record<string, string>): Promise<DbModule> {
  vi.resetModules();
  Object.assign(process.env, env);
  current = await import('../../db');
  return current;
}

async function startProxy(): Promise<PgWireProxy> {
  const target = new URL(APP_URL!);
  proxy = await startPgWireProxy({ host: target.hostname, port: Number(target.port || 5432) });
  return proxy;
}

function admission(db: DbModule) {
  const gate = db.getRequestPoolAdmission();
  if (!gate) throw new Error('db module did not register its pool admission gate');
  return gate;
}

async function backendPid(db: DbModule): Promise<number> {
  const rows = (await db.db.execute(sql`select pg_backend_pid() as pid`)) as unknown as Array<{ pid: number }>;
  return Number(rows[0]!.pid);
}

const ORG_CONTEXT = {
  scope: 'organization' as const,
  orgId: ORG,
  accessibleOrgIds: [ORG],
  accessiblePartnerIds: null,
  userId: null,
  currentPartnerId: null,
};

const TYPED_TIMEOUTS = ['DbPoolAcquireTimeoutError', 'DbAccessContextPrologueTimeoutError'];

describeIf('db pool recovery (#8143)', () => {
  beforeAll(() => {
    admin = postgres(APP_URL!, { max: 1 });
  });
  afterAll(async () => {
    await admin.end({ timeout: 1 });
  });
  afterEach(async () => {
    await proxy?.close();
    proxy = null;
    if (current) {
      await Promise.race([current.closeDb(), sleep(3_000)]);
      current = null;
    }
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  async function stallScenario(db: DbModule): Promise<{ errors: number; stallEndedAt: number }> {
    const calls = Array.from({ length: 12 }, () =>
      db.withSystemDbAccessContext(() => db.db.execute(sql`select pg_sleep(0.05)`)),
    );
    await new Promise((resolve) => setImmediate(resolve));
    busyWait(2_500); // longer than both 1 s budgets
    const stallEndedAt = Date.now();
    const outcomes = await Promise.allSettled(calls);
    let errors = 0;
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        errors += 1;
        expect(TYPED_TIMEOUTS).toContain((outcome.reason as Error).name);
      }
    }
    return { errors, stallEndedAt };
  }

  it('permits and real connections are back at max within 30 s of an event-loop stall', async () => {
    const db = await loadFreshDb({
      DB_POOL_MAX: '3',
      DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS: '1000',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '1000',
    });
    await Promise.all([0, 1].map(() => db.withSystemDbAccessContext(() => db.db.execute(sql`select 1`))));

    const { stallEndedAt } = await stallScenario(db);

    await waitFor(() => {
      const s = admission(db).snapshot();
      return s.inUse === 0 && s.waiting === 0 && s.abandoned === 0 && s.effectivePermits === 3;
    }, 30_000, 'all permits returned');
    expect(Date.now() - stallEndedAt).toBeLessThan(30_000);

    // All three permits usable AT ONCE on three distinct backends: two
    // top-level contexts plus one nested escalation (the reserve).
    const pids: number[] = [];
    let release!: () => void;
    const allHeld = new Promise<void>((resolve) => { release = resolve; });
    const hold = async () => {
      pids.push(await backendPid(db));
      if (pids.length === 3) release();
      await allHeld;
    };
    const parent = (nest: boolean) => db.withSystemDbAccessContext(async () => {
      if (nest) {
        // The nesting parent's own backend counts too: it stays held while the
        // nested context (served from the reserve) runs on a third backend.
        pids.push(await backendPid(db));
        await db.runOutsideDbContext(() => db.withSystemDbAccessContext(hold));
        return;
      }
      await hold();
    });
    await Promise.race([
      Promise.all([parent(true), parent(false)]).then(() => undefined),
      sleep(5_000).then(() => { throw new Error('could not hold all three permits at once'); }),
    ]);
    expect(pids).toHaveLength(3);
    expect(new Set(pids).size).toBe(3);

    const states = await admin`select pid, state from pg_stat_activity where pid = any(${pids}::int[])`;
    for (const row of states) expect(row.state).toBe('idle');
  }, 60_000);

  it('grace keeps buffered replies from failing after a stall (measured, not assumed)', async () => {
    const db = await loadFreshDb({
      DB_POOL_MAX: '3',
      DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS: '1000',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '1000',
    });
    await db.withSystemDbAccessContext(() => db.db.execute(sql`select 1`));

    process.env.DB_TIMER_LAG_GRACE_MS = '2000';
    const withGrace = await stallScenario(db);
    await waitFor(() => admission(db).snapshot().inUse === 0, 30_000, 'drain after grace run');

    process.env.DB_TIMER_LAG_GRACE_MS = '0';
    const withoutGrace = await stallScenario(db);
    await waitFor(() => admission(db).snapshot().inUse === 0, 30_000, 'drain after no-grace run');

    console.info(`[W04 grace comparison] errors with grace=${withGrace.errors}, without=${withoutGrace.errors} (of 12)`);
    expect(withGrace.errors).toBeLessThanOrEqual(withoutGrace.errors);
  }, 90_000);

  it('slow database: the caller fails fast, fn never runs, the late reply rolls back, no GUC survives', async () => {
    const p = await startProxy();
    const db = await loadFreshDb({
      DATABASE_URL_APP: p.urlFor(APP_URL!),
      DB_POOL_MAX: '1',
      DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS: '1000',
    });
    const pidBefore = await db.withSystemDbAccessContext(() => backendPid(db));

    p.armHoldResponsesAfterNextPrologue();
    const fn = vi.fn(async () => 'never');
    await expect(db.withDbAccessContext(ORG_CONTEXT, fn)).rejects.toMatchObject({
      name: 'DbAccessContextPrologueTimeoutError',
    });
    expect(admission(db).snapshot()).toMatchObject({ inUse: 1, abandoned: 1, effectivePermits: 0 });

    p.resume();
    await waitFor(() => admission(db).snapshot().inUse === 0, 10_000, 'abandoned permit returned by rollback');
    expect(fn).not.toHaveBeenCalled();
    expect(admission(db).totals().abandonedReturned.rollback).toBe(1);

    // DB_POOL_MAX=1, so this bare read runs on the SAME backend that carried the
    // abandoned org-scope prologue. Its GUCs were transaction-local.
    const rows = (await db.db.execute(
      sql`select pg_backend_pid() as pid, current_setting('breeze.scope', true) as scope, current_setting('breeze.org_id', true) as org_id`,
    )) as unknown as Array<{ pid: number; scope: string | null; org_id: string | null }>;
    expect(Number(rows[0]!.pid)).toBe(pidBefore);
    expect(rows[0]!.scope ?? '').toBe('');
    expect(rows[0]!.org_id ?? '').toBe('');
  }, 30_000);

  it('true ClientRead wedge: the deferred reclaim terminates it and the pool reconnects', async () => {
    const p = await startProxy();
    const db = await loadFreshDb({
      DATABASE_URL_APP: p.urlFor(APP_URL!),
      DB_POOL_MAX: '1',
      DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS: '1000',
      DB_WEDGED_BACKEND_RECLAIM_MIN_INTERVAL_MS: '1000',
      DB_WEDGED_BACKEND_CONFIRM_DELAY_MS: '100',
    });
    await db.withSystemDbAccessContext(() => db.db.execute(sql`select 1`));

    p.armWedgeOnNextPrologue();
    await expect(db.withSystemDbAccessContext(async () => 'never')).rejects.toMatchObject({
      name: 'DbAccessContextPrologueTimeoutError',
    });

    let wedgedPid = 0;
    await waitFor(async () => {
      const rows = await admin`
        select pid from pg_stat_activity
         where state = 'active' and wait_event = 'ClientRead'
           and query like 'select set_config(''breeze.%'`;
      wedgedPid = rows[0]?.pid ?? 0;
      return wedgedPid !== 0;
    }, 5_000, 'the #6048 wedge shape is visible in pg_stat_activity');

    await waitFor(async () => (await admin`select 1 from pg_stat_activity where pid = ${wedgedPid}`).length === 0,
      15_000, 'the wedged backend is terminated');
    await waitFor(() => admission(db).totals().abandonedReturned['connection-closed'] === 1
      && admission(db).snapshot().inUse === 0, 5_000, 'the permit returns via connection-closed');

    await expect(db.withSystemDbAccessContext(() => db.db.execute(sql`select 1`))).resolves.toBeDefined();
  }, 40_000);

  it('a request that cannot get a permit never reaches the driver (no zombie BEGIN)', async () => {
    const p = await startProxy();
    const db = await loadFreshDb({
      DATABASE_URL_APP: p.urlFor(APP_URL!),
      DB_POOL_MAX: '1',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '1000',
      DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS: '1000',
    });
    await db.withSystemDbAccessContext(() => db.db.execute(sql`select 1`));
    const holder = db.withSystemDbAccessContext(() => db.db.execute(sql`select pg_sleep(2.5)`));
    await waitFor(() => p.stats.begins === 2, 2_000, 'holder BEGIN sent');

    const waiters = [0, 1, 2].map(() => db.withSystemDbAccessContext(async () => 'late'));
    for (const waiter of waiters) {
      await expect(waiter).rejects.toMatchObject({ name: 'DbPoolAcquireTimeoutError' });
    }
    await holder;
    await sleep(1_000);
    expect(p.stats.begins).toBe(2);
    const acquireExpiries = db.getDeadlineExpiryTotals().acquire;
    expect(acquireExpiries['on-time'] + acquireExpiries.late).toBe(3);
  }, 30_000);

  it('nested escalation at saturation makes progress instead of stalling to a timeout', async () => {
    const db = await loadFreshDb({
      DB_POOL_MAX: '3',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '3000',
      DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS: '1000',
    });
    const parent = () => db.withSystemDbAccessContext(async () => {
      await db.db.execute(sql`select pg_sleep(0.2)`);
      return db.runOutsideDbContext(() => db.withSystemDbAccessContext(async () => {
        await db.db.execute(sql`select 1`);
        return 'nested-ok';
      }));
    });
    await expect(Promise.all([parent(), parent(), parent()])).resolves.toEqual(['nested-ok', 'nested-ok', 'nested-ok']);
  }, 30_000);
});
```

- [ ] **Step 3: Run the suite to verify it is RED against the current wiring**

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/dbPoolRecovery.integration.test.ts
```
Expected FAILS on a base that has #8243 but not the rest of this wave (record them; each one is a discriminating red):
- "permits and real connections…", "grace keeps…", "slow database…": `TypeError: db.getRequestPoolAdmission is not a function` (no gate yet).
- "true ClientRead wedge…": `timed out after 15000ms waiting for: the wedged backend is terminated` (#8243 still requests the pass at expiry, when the backend is younger than `minAgeMs`, and nothing asks again).
- "no zombie BEGIN": the three waiters DO fail with `DbPoolAcquireTimeoutError` (#8243), but `expected 5 to be 2` on `p.stats.begins`: each timed-out waiter stayed in the driver queue and later spent a real connection on BEGIN + ROLLBACK (#8243's `DbPoolAcquireAbortedError` release path).
- "nested escalation…": rejects with `DbPoolAcquireTimeoutError` (three parents hold all three connections; the nested opens queue in the driver until the 3 s acquire budget expires).

- [ ] **Step 4: Commit the RED suite**

```bash
git add apps/api/src/__tests__/integration/helpers/pgWireProxy.ts apps/api/src/__tests__/integration/dbPoolRecovery.integration.test.ts
git commit -m "test(db): real-Postgres pool-recovery acceptance suite and wire proxy (red) (#8143)"
```

---

### Task 7: Wire the gate into #8243's openers; deferred reclaim; never commit an abandoned transaction

**Files:**
- Modify: `apps/api/src/db/index.ts` (#8243's version: imports; pool construction; `onPrologueDeadlineExpired`; `withContextAcquireAndPrologueDeadline` → `runInPoolSlot`; remove `withAfterContextExit`; `withDbAccessContext` and `withArchivedOrgReadContext` returns; re-exports)
- Modify: `apps/api/src/db/prologueDeadlineWiring.test.ts`
- Create: `apps/api/src/db/poolAdmissionWiring.test.ts`

**Interfaces:**
- Consumes: Task 2 (`withAcquireAndPrologueDeadline`, `PoolAcquisition` incl. `signal`, `PrologueDeadlineExpiry` incl. `timer`, `DbAccessContextPrologueTimeoutError`, `getDeadlineExpiryTotals`), Task 3 (`createPoolAdmission`, `registerRequestPoolAdmission`, `classifyPoolSlotSettlement`, `PoolSlot`), Task 4 (`createAbandonedSlotReclaimScheduler`).
- Produces (new exports from `db/index.ts`): `getRequestPoolAdmission`, `getDeadlineExpiryTotals`, types `PoolAdmissionSnapshot`, `PoolAdmissionTotals`. #8243's exports (`DbPoolAcquireTimeoutError`, `DbPoolAcquireAbortedError`, `getDbPoolAcquireTimeoutMs`) stay.
- Behaviour: every outermost opener takes a permit inside the acquire budget; a prologue expiry abandons the permit of the transaction it belongs to (found through the pool-slot ALS) and defers the reclaim; an abandoned transaction never commits; deferred work starts on the transaction's settlement.

- [ ] **Step 1: Write the failing wiring tests**

In `prologueDeadlineWiring.test.ts`, every test that expects `requestWedgedBackendReclaim` to have been called right after a PROLOGUE expiry changes to the deferred form. Find them with `grep -n "requestWedgedBackendReclaim).toHaveBeenCalled" src/db/prologueDeadlineWiring.test.ts`: on main that is the first test (`'rejects withDbAccessContext with the typed error when the prologue statement wedges'`), and #8243 adds `'a wedged prologue after a slow acquire is still timed from acquisition and still reclaims'` (or whatever it is named when merged). In each, replace the immediate `expect(requestWedgedBackendReclaim).toHaveBeenCalledTimes(1);` with:

```ts
    // #8143: no pass at expiry (the set_config cannot be old enough yet). The
    // permit is still held one prologue budget + 1 s later, so the scheduler
    // asks then, with the same age threshold.
    expect(requestWedgedBackendReclaim).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(17_000);
    expect(requestWedgedBackendReclaim).toHaveBeenCalledTimes(1);
    expect(requestWedgedBackendReclaim).toHaveBeenCalledWith({ minAgeMs: 15_000 });
```
Assertions that the reclaim is NOT called (acquire expiry, late-resolving statement, disabled bound) stay as they are.

Create `poolAdmissionWiring.test.ts`:

```ts
// apps/api/src/db/poolAdmissionWiring.test.ts
/**
 * #8143 — the admission gate at the REAL context openers, on top of #8229's
 * acquire/prologue budgets. drizzle is faked (as in prologueDeadlineWiring.test.ts)
 * so a transaction can be made to hang, or to settle late, on demand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { drizzleFactory, transactionImpl } = vi.hoisted(() => {
  const transactionImpl = vi.fn();
  const drizzleFactory = vi.fn(() => ({
    transaction: (fn: (tx: unknown) => Promise<unknown>) => transactionImpl(fn),
  }));
  return { drizzleFactory, transactionImpl };
});

vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: drizzleFactory }));
vi.mock('postgres', () => ({
  default: vi.fn(() => Object.assign(vi.fn(), { options: { parsers: {}, serializers: {} } })),
}));
vi.mock('./wedgedBackends', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./wedgedBackends')>()),
  requestWedgedBackendReclaim: vi.fn(() => null),
}));

const originalEnv = { ...process.env };

/** Emulates postgres.js: the callback's rejection is the transaction's rejection. */
function runCallback(tx: unknown) {
  return (fn: (t: unknown) => Promise<unknown>) => fn(tx);
}

const okTx = () => ({ execute: vi.fn(() => Promise.resolve([])) });

describe('#8143 pool admission wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
    process.env.DATABASE_URL_APP = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
    process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS = '15000';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('a request that times out waiting for a permit never reaches the driver', async () => {
    process.env.DB_POOL_MAX = '1';
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '1000';
    let finishHolder!: () => void;
    const holderCommit = new Promise<void>((resolve) => { finishHolder = resolve; });
    transactionImpl.mockImplementationOnce(async (fn: (t: unknown) => Promise<unknown>) => {
      const value = await fn(okTx());
      await holderCommit; // COMMIT in flight: the holder keeps its permit
      return value;
    });
    const db = await import('./index');

    const holder = db.withSystemDbAccessContext(async () => 'held');
    const waiter = db.withSystemDbAccessContext(async () => 'never');
    const assertion = expect(waiter).rejects.toBeInstanceOf(db.DbPoolAcquireTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(transactionImpl).toHaveBeenCalledTimes(1);
    expect(db.getRequestPoolAdmission()!.totals().cancelledWaiters).toBe(1);
    finishHolder();
    await expect(holder).resolves.toBe('held');
    expect(db.getRequestPoolAdmission()!.snapshot()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('holds an abandoned permit until the late prologue settles, then hands it on', async () => {
    process.env.DB_POOL_MAX = '1';
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '10000';
    const lateTx = { execute: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve([]), 20_000))) };
    transactionImpl.mockImplementationOnce(runCallback(lateTx));
    transactionImpl.mockImplementationOnce(runCallback(okTx()));
    const db = await import('./index');
    const fn = vi.fn(async () => 'rows');

    const first = db.withSystemDbAccessContext(fn);
    const firstAssertion = expect(first).rejects.toBeInstanceOf(db.DbAccessContextPrologueTimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await firstAssertion;
    expect(db.getRequestPoolAdmission()!.snapshot()).toMatchObject({ inUse: 1, abandoned: 1, effectivePermits: 0 });

    const second = db.withSystemDbAccessContext(async () => 'second');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(second).resolves.toBe('second');
    expect(fn).not.toHaveBeenCalled();
    expect(db.getRequestPoolAdmission()!.totals().abandonedReturned.rollback).toBe(1);
  });

  it('never commits an abandoned transaction, even when caller code swallows the inner timeout', async () => {
    process.env.DB_POOL_MAX = '4';
    let statements = 0;
    const tx = {
      // Statement 1: outer system prologue. Statement 2: the narrowing prologue, which wedges.
      execute: vi.fn(() => (++statements === 2 ? new Promise(() => {}) : Promise.resolve([]))),
    };
    let transactionOutcome: 'committed' | 'rolled-back' | null = null;
    transactionImpl.mockImplementationOnce(async (fn: (t: unknown) => Promise<unknown>) => {
      try {
        const value = await fn(tx);
        transactionOutcome = 'committed';
        return value;
      } catch (err) {
        transactionOutcome = 'rolled-back';
        throw err;
      }
    });
    const db = await import('./index');

    const caller = db.withSystemDbAccessContext(async () => {
      try {
        await db.withResolvedDbAccessContext(
          async () => ({ context: { ...db.SYSTEM_DB_ACCESS_CONTEXT, scope: 'organization', orgId: null, accessibleOrgIds: [] }, value: 1 }),
          async () => 'inner',
        );
      } catch {
        // swallowed on purpose: the hazard under test
      }
      return 'swallowed';
    });
    const assertion = expect(caller).rejects.toBeInstanceOf(db.DbAccessContextPrologueTimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    await vi.advanceTimersByTimeAsync(1);
    expect(transactionOutcome).toBe('rolled-back');
  });

  it('starts deferred after-exit work only after an abandoned transaction has actually settled', async () => {
    process.env.DB_POOL_MAX = '4';
    let finishRollback!: () => void;
    const rollbackDone = new Promise<void>((resolve) => { finishRollback = resolve; });
    let statements = 0;
    const tx = {
      execute: vi.fn(() => (++statements === 2 ? new Promise(() => {}) : Promise.resolve([]))),
    };
    transactionImpl.mockImplementationOnce(async (fn: (t: unknown) => Promise<unknown>) => {
      try {
        return await fn(tx);
      } catch (err) {
        await rollbackDone; // ROLLBACK still in flight after the caller was released
        throw err;
      }
    });
    const db = await import('./index');
    const task = vi.fn();
    const caller = db.withSystemDbAccessContext(async () => {
      db.runAfterDbContextExit('wiring.after', task);
      await db.withResolvedDbAccessContext(
        async () => ({ context: { ...db.SYSTEM_DB_ACCESS_CONTEXT, scope: 'organization', orgId: null, accessibleOrgIds: [] }, value: 1 }),
        async () => 'inner',
      );
      return 'unreachable';
    });
    const assertion = expect(caller).rejects.toBeInstanceOf(db.DbAccessContextPrologueTimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    // The caller is released, but the transaction has not settled: not yet.
    expect(task).not.toHaveBeenCalled();
    finishRollback();
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('a nested escalation is admitted from the reserve while two parents hold the top-level permits', async () => {
    process.env.DB_POOL_MAX = '3';
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '1000';
    transactionImpl.mockImplementation(runCallback(okTx()));
    const db = await import('./index');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const parentA = db.withSystemDbAccessContext(async () => {
      await gate;
      return 'a';
    });
    const parentB = db.withSystemDbAccessContext(() =>
      db.runOutsideDbContext(() => db.withSystemDbAccessContext(async () => 'nested')),
    );
    // Treated as top-level, the nested open would sit behind the cap
    // (permits - reserve = 2) and fail with DbPoolAcquireTimeoutError.
    const outcome = parentB.then((value) => value, (err: unknown) => (err as Error).name);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toBe('nested');
    release();
    await expect(parentA).resolves.toBe('a');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/db/poolAdmissionWiring.test.ts src/db/prologueDeadlineWiring.test.ts`
Expected: FAIL — `db.getRequestPoolAdmission is not a function`; the edited prologue tests fail with `expected "requestWedgedBackendReclaim" to not be called` (#8243 still requests the pass at expiry); "never commits" fails with `transactionOutcome` `'committed'` and the caller resolving `'swallowed'`.

- [ ] **Step 3: Implement in `apps/api/src/db/index.ts`**

3a. Imports. In #8243's `./prologueDeadline` import add `DbAccessContextPrologueTimeoutError` and `type PrologueDeadlineExpiry` (keep `withAcquireAndPrologueDeadline`, `withPrologueDeadline`, `type PoolAcquisition`, `type PrologueDeadline`). Remove `import { requestWedgedBackendReclaim } from './wedgedBackends';` and the `claimDbPoolHealthCaptureSlot` / `getDbPoolHealthCaptureThrottleMs` import (they moved to `abandonedSlotReclaim.ts` in Task 4). Keep `captureMessage` (used by the #1105 tripwire and the contextless-write guard). Add:

```ts
import {
  classifyPoolSlotSettlement,
  createPoolAdmission,
  registerRequestPoolAdmission,
  type PoolSlot,
} from './poolAdmission';
import { createAbandonedSlotReclaimScheduler } from './abandonedSlotReclaim';
```

3b. Pool construction: compute the max once, then register the gate right after `client`:

```ts
const requestPoolMax = getDbPoolMax();

const client = postgres(requestDatabaseConfig.url, {
  max: requestPoolMax,
  // ...every other option unchanged...
});

// #8143. One permit per outermost transaction, DB_POOL_MAX of them, granted
// inside #8229's acquire budget. See db/poolAdmission.ts.
const requestPoolAdmission = createPoolAdmission({ permits: requestPoolMax });
registerRequestPoolAdmission(requestPoolAdmission);
const abandonedSlotReclaimScheduler = createAbandonedSlotReclaimScheduler();
```

3c. Next to `afterContextExitStorage`:

```ts
// #8143. The pool permit of the OUTERMOST context in this async scope.
// Deliberately NOT exited by runOutsideDbContext: a context opened from inside
// runOutsideDbContext while this permit is still held is a NESTED acquisition
// (the #1105 escalation) and is served from the nested reserve. Prologue timers
// are armed inside the transaction callback, so their expiry runs in this
// store's context and onPrologueDeadlineExpired can find the permit.
const poolSlotStorage = new AsyncLocalStorage<PoolSlot>();
```

3d. Replace `onPrologueDeadlineExpired` (main's version, which #8243 left unchanged) with:

```ts
/**
 * Prologue expiry (#6048, re-scoped by #8143). Works for BOTH prologue sites:
 * the opener's own (its timer runs inside the permit's ALS context) and the
 * narrowing prologue of withResolvedDbAccessContext (same connection, same
 * permit). Abandoning the permit releases the outermost caller at once through
 * `slot.abandonment` and makes COMMIT impossible. No reclaim pass is requested
 * here: the set_config cannot be old enough yet. The scheduler asks if the
 * permit is still held one prologue budget + 1 s later.
 */
function onPrologueDeadlineExpired(expiry: PrologueDeadlineExpiry): void {
  console.warn(
    `[db-prologue-deadline] RLS GUC prologue for ${expiry.contextLabel} exceeded ${expiry.timeoutMs}ms `
      + `(elapsed ${expiry.elapsedMs}ms, timer ${expiry.timer}). The transaction is abandoned and will roll back; `
      + 'its pool permit returns when it settles. '
      + (expiry.timer === 'late' ? 'The timer fired late, so the event loop was stalled (#3022). ' : '')
      + 'A permit still held one more prologue budget later triggers a wedged-backend reclaim pass (#6048, #8143).',
  );
  const slot = poolSlotStorage.getStore();
  if (!slot) return;
  slot.abandon(new DbAccessContextPrologueTimeoutError(expiry));
  abandonedSlotReclaimScheduler.track(slot, expiry.timeoutMs);
}
```
(Delete the old body's `requestWedgedBackendReclaim(...)` call and its `.then` outcome logging; Task 4's `reportReclaimOutcome` now owns that.)

3e. Replace #8243's `withContextAcquireAndPrologueDeadline` with `runInPoolSlot`, and delete `withAfterContextExit` (this function owns the deferral list now). Keep #8243's `onPoolAcquireExpired` and `withContextPrologueDeadline` as they are.

```ts
/**
 * Every OUTERMOST opener that checks a connection out goes through here.
 *
 *   1. #8229's acquire clock starts. Inside it, take a pool permit; if the
 *      budget expires first, `acquisition.signal` removes us from the gate
 *      queue, so the request never reaches the driver (#8143).
 *   2. The transaction callback calls `acquisition.acquired()` first, which
 *      starts the prologue clock (#8229) and refuses a late connection.
 *   3. The permit is released when the UNDERLYING transaction settles, never
 *      when the caller is answered.
 *   4. The caller is answered from a race of the transaction against the
 *      permit's abandonment, so any prologue on this connection, including the
 *      narrowing one in withResolvedDbAccessContext, releases the caller.
 *   5. runAfterDbContextExit work starts when the transaction has settled.
 */
function runInPoolSlot<T>(
  opener: string,
  context: DbAccessContext,
  open: (acquisition: PoolAcquisition, slot: PoolSlot) => Promise<T>,
): Promise<T> {
  const label = prologueLabel(opener, context);
  const parent = poolSlotStorage.getStore();
  const nested = parent !== undefined && !parent.released;
  return withAcquireAndPrologueDeadline(
    label,
    async (acquisition) => {
      const slot = await requestPoolAdmission.acquire(label, { nested, signal: acquisition.signal });
      const pending: AfterContextExitTask[] = [];
      let transaction: Promise<T>;
      try {
        transaction = afterContextExitStorage.run(pending, () =>
          poolSlotStorage.run(slot, () => open(acquisition, slot)),
        );
      } catch (err) {
        slot.release(classifyPoolSlotSettlement(err));
        throw err;
      }
      void transaction
        .then(
          () => slot.release('resolved'),
          (err: unknown) => slot.release(classifyPoolSlotSettlement(err)),
        )
        .finally(() => {
          for (const task of pending.splice(0)) startAfterContextExitTask(task);
        });
      return Promise.race([transaction, slot.abandonment]);
    },
    { onExpired: onPrologueDeadlineExpired, onAcquireExpired: onPoolAcquireExpired },
  );
}
```

3f. In `withDbAccessContext`, replace `return withAfterContextExit(() => withContextAcquireAndPrologueDeadline('withDbAccessContext', context, (acquisition) => baseDb.transaction(async (tx) => { … }, options), ));` with:

```ts
  return runInPoolSlot('withDbAccessContext', context, (acquisition, slot) =>
    baseDb.transaction(async (tx) => {
      // FIRST, before any statement: stops the acquire clock, starts the
      // prologue clock, and refuses a connection that arrived late (#8229).
      const deadline = acquisition.acquired();
      await applyAccessContextGucs(tx as unknown as GucExecutor, context, deadline);
      // Disarmed the instant the prologue lands: `fn` is the caller's own work
      // and is never bounded by the prologue budget (#6048).
      deadline.disarm();

      const startedAt = warnMs > 0 ? Date.now() : 0;
      try {
        const result = await dbContextStorage.run(tx as unknown as typeof baseDb, () =>
          dbContextMetaStorage.run(context, fn),
        );
        // #8143: an abandoned transaction must never COMMIT. Its caller already
        // has a typed error; a caller that swallowed an inner timeout and
        // returned normally would otherwise commit work nobody is waiting for,
        // on a connection whose RLS context may not be the one it believes.
        slot.throwIfAbandoned();
        return result;
      } finally {
        reportHeldContextIfNeeded({
          scope: context.scope,
          label: context.label,
          opener,
          startedAt,
          warnMs,
        });
      }
    }, options),
  );
```

3g. In `withArchivedOrgReadContext`, the same shape:

```ts
  return runInPoolSlot('withArchivedOrgReadContext', context, (acquisition, slot) =>
    baseDb.transaction(async (tx) => {
      // Before any statement — see withDbAccessContext (#8229).
      const deadline = acquisition.acquired();
      const executor = tx as unknown as GucExecutor;
      // FIRST statement in the transaction: `SET TRANSACTION` may not follow a
      // query, so it precedes even the `set_config` prologue.
      deadline.throwIfAborted();
      await executor.execute(sql`SET TRANSACTION READ ONLY`);
      await applyAccessContextGucs(executor, context, deadline);
      deadline.disarm();

      const startedAt = warnMs > 0 ? Date.now() : 0;
      try {
        const result = await dbContextStorage.run(tx as unknown as typeof baseDb, () =>
          dbContextMetaStorage.run(context, fn),
        );
        slot.throwIfAbandoned(); // #8143: never commit an abandoned transaction
        return result;
      } finally {
        reportHeldContextIfNeeded({
          scope: context.scope,
          label: context.label,
          opener,
          startedAt,
          warnMs,
        });
      }
    }),
  );
```

3h. `withResolvedDbAccessContext` keeps #8243's code (`withContextPrologueDeadline` with `onExpired: onPrologueDeadlineExpired`). No edit: the new `onPrologueDeadlineExpired` finds the OUTER permit through `poolSlotStorage`, because the narrowing prologue runs inside the outer transaction callback.

3i. Next to #8243's `prologueDeadline` re-export block, add `getDeadlineExpiryTotals` to that block and append:

```ts
// #8143 — the process gate, for metrics and the pool-recovery integration suite.
export {
  getRequestPoolAdmission,
  type PoolAdmissionSnapshot,
  type PoolAdmissionTotals,
} from './poolAdmission';
```

- [ ] **Step 4: Run unit tests, the integration suite and typecheck**

```bash
cd apps/api && npx vitest run src/db/
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/dbPoolRecovery.integration.test.ts src/__tests__/integration/accessContextGucs.integration.test.ts src/__tests__/integration/postgresJsBeginReservation.integration.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit=$?"
```
Expected: every `src/db/*.test.ts` PASS (`afterContextExit`, `accessContextGucs`, `previewTransaction`, `rowCount`, `prologueDeadline*`, `poolAdmission*`, `abandonedSlotReclaim`); all six `dbPoolRecovery` tests PASS (copy the `[W04 grace comparison]` line into the task notes for the PR body); `tsc exit=0`. If the cold `import('./index')` exceeds 5 s on a loaded host, rerun with `--testTimeout=60000` (environmental, noted on #8243).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/index.ts apps/api/src/db/prologueDeadlineWiring.test.ts apps/api/src/db/poolAdmissionWiring.test.ts
git commit -m "fix(db): admit request transactions through the pool gate; defer reclaim; never commit an abandoned transaction (#8143)"
```

---

### Task 8: Prometheus series and alert

**Files:**
- Modify: `apps/api/src/services/metricsRuntime.ts`
- Modify: `apps/api/src/routes/metrics.test.ts`
- Modify: `monitoring/rules/breeze-rules.yml`, `apps/docs/src/content/docs/monitoring/alerts.mdx`

**Interfaces:**
- Consumes: Task 3 `getRequestPoolAdmission`, `ABANDONED_RETURN_KINDS`; Task 1 `TIMER_LATENESS_VALUES`; Task 2 `getDeadlineExpiryTotals`.
- Produces series (read on scrape; `_total` series are monotonic gauges, matching the existing `breeze_db_wedged_backend_reclaim_terminated_total` precedent):
  - `breeze_db_pool_admission_permits`, `…_in_use`, `…_waiting`, `…_abandoned`, `…_effective_permits` (each `-1` when the process has no request pool)
  - `breeze_db_pool_admission_cancelled_waiters_total` (requests that left the gate at acquire expiry, never reaching the driver)
  - `breeze_db_pool_admission_abandoned_total`, `breeze_db_pool_admission_abandoned_returned_total{how="rollback|connection-closed"}`
  - `breeze_db_pool_acquire_timeouts_total{timer="late|on-time"}` (#8243's acquire budget)
  - `breeze_db_prologue_deadline_expiries_total{timer="late|on-time"}`

- [ ] **Step 1: Write the failing test** (in `routes/metrics.test.ts`; add the imports and a new `describe` inside `describe('metrics routes', …)`)

```ts
import {
  createPoolAdmission,
  registerRequestPoolAdmission,
  __resetRequestPoolAdmissionForTests,
} from '../db/poolAdmission';
import { __resetDeadlineExpiryTotalsForTests, withAcquireAndPrologueDeadline } from '../db/prologueDeadline';
```

```ts
  describe('db pool admission gauges (#8143)', () => {
    afterEach(() => {
      __resetRequestPoolAdmissionForTests();
      __resetDeadlineExpiryTotalsForTests();
    });

    async function scrape(): Promise<string> {
      const res = await app.request('/metrics', { headers: { Authorization: 'Bearer token' } });
      expect(res.status).toBe(200);
      return res.text();
    }

    it('publishes -1 for the pool-size series when this process has no request pool', async () => {
      const body = await scrape();
      for (const name of [
        'breeze_db_pool_admission_permits',
        'breeze_db_pool_admission_in_use',
        'breeze_db_pool_admission_waiting',
        'breeze_db_pool_admission_abandoned',
        'breeze_db_pool_admission_effective_permits',
      ]) {
        expect(getMetricLine(body, name)).toBe(`${name} -1`);
      }
      expect(getMetricLine(body, 'breeze_db_prologue_deadline_expiries_total', { timer: 'late' }))
        .toBe('breeze_db_prologue_deadline_expiries_total{timer="late"} 0');
    });

    it('tracks permits in use, abandoned permits and the effective pool on scrape', async () => {
      const gate = createPoolAdmission({ permits: 4 });
      registerRequestPoolAdmission(gate);
      const held = await gate.acquire('metrics-test');
      const abandoned = await gate.acquire('metrics-test');
      abandoned.abandon(new Error('prologue expired'));

      const during = await scrape();
      expect(getMetricLine(during, 'breeze_db_pool_admission_permits')).toBe('breeze_db_pool_admission_permits 4');
      expect(getMetricLine(during, 'breeze_db_pool_admission_in_use')).toBe('breeze_db_pool_admission_in_use 2');
      expect(getMetricLine(during, 'breeze_db_pool_admission_abandoned')).toBe('breeze_db_pool_admission_abandoned 1');
      expect(getMetricLine(during, 'breeze_db_pool_admission_effective_permits'))
        .toBe('breeze_db_pool_admission_effective_permits 3');

      abandoned.release('connection-closed');
      held.release('resolved');
      const after = await scrape();
      expect(getMetricLine(after, 'breeze_db_pool_admission_in_use')).toBe('breeze_db_pool_admission_in_use 0');
      expect(getMetricLine(after, 'breeze_db_pool_admission_effective_permits'))
        .toBe('breeze_db_pool_admission_effective_permits 4');
      expect(getMetricLine(after, 'breeze_db_pool_admission_abandoned_returned_total', { how: 'connection-closed' }))
        .toBe('breeze_db_pool_admission_abandoned_returned_total{how="connection-closed"} 1');
    });

    it('counts acquire timeouts by timer lateness', async () => {
      vi.useFakeTimers();
      try {
        const expired = withAcquireAndPrologueDeadline('metrics-test', () => new Promise<never>(() => {}), {
          acquireTimeoutMs: 1_000,
          timeoutMs: 15_000,
        }).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(1_000);
        await expired;
      } finally {
        vi.useRealTimers();
      }
      const body = await scrape();
      expect(getMetricLine(body, 'breeze_db_pool_acquire_timeouts_total', { timer: 'on-time' }))
        .toBe('breeze_db_pool_acquire_timeouts_total{timer="on-time"} 1');
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/metrics.test.ts`
Expected: FAIL — `getMetricLine(...)` returns `undefined` for `breeze_db_pool_admission_permits`.

- [ ] **Step 3: Implement in `metricsRuntime.ts`**

Imports (after the `../db/wedgedBackends` import):

```ts
import { ABANDONED_RETURN_KINDS, getRequestPoolAdmission } from '../db/poolAdmission';
import { getDeadlineExpiryTotals } from '../db/prologueDeadline';
import { TIMER_LATENESS_VALUES } from '../db/lagTolerantTimeout';
```
(Add `../db/poolAdmission`, `../db/prologueDeadline` and `../db/lagTolerantTimeout` to the header's "Import closure" sentence; all are leaves that never reach `routes/`.)

Declarations (after the wedged-backend gauges):

```ts
// #8143 — request-pool admission. Permits, not connections: bare-pool queries
// are not gated (db/poolAdmission.ts). The five size series read -1 in a
// process with no request pool, so "no pool" can never read as "pool empty".
const dbPoolAdmissionPermitsGauge = new Gauge({
  name: 'breeze_db_pool_admission_permits',
  help: 'Transaction permits configured for the request pool (DB_POOL_MAX); -1 when this process has no request pool',
  registers: [register],
});
const dbPoolAdmissionInUseGauge = new Gauge({
  name: 'breeze_db_pool_admission_in_use',
  help: 'Transaction permits currently held, including permits held by abandoned transactions; -1 when no request pool',
  registers: [register],
});
const dbPoolAdmissionWaitingGauge = new Gauge({
  name: 'breeze_db_pool_admission_waiting',
  help: 'Requests waiting for a transaction permit; -1 when no request pool',
  registers: [register],
});
const dbPoolAdmissionAbandonedGauge = new Gauge({
  name: 'breeze_db_pool_admission_abandoned',
  help: 'Permits held by transactions abandoned at their RLS prologue deadline and not yet settled; -1 when no request pool',
  registers: [register],
});
const dbPoolAdmissionEffectivePermitsGauge = new Gauge({
  name: 'breeze_db_pool_admission_effective_permits',
  help: 'Permits minus abandoned permits: the pool size the gate can actually hand out; -1 when no request pool',
  registers: [register],
});
const dbPoolAdmissionCancelledWaitersGauge = new Gauge({
  name: 'breeze_db_pool_admission_cancelled_waiters_total',
  help: 'Requests that left the admission queue at acquire expiry and never reached the driver; monotonic',
  registers: [register],
});
const dbPoolAdmissionAbandonedTotalGauge = new Gauge({
  name: 'breeze_db_pool_admission_abandoned_total',
  help: 'Permits abandoned at an RLS prologue deadline since process start; monotonic',
  registers: [register],
});
const dbPoolAdmissionAbandonedReturnedGauge = new Gauge({
  name: 'breeze_db_pool_admission_abandoned_returned_total',
  help: 'Abandoned permits returned, by how: rollback (late statement completed) or connection-closed (reclaimed); monotonic',
  labelNames: ['how'] as const,
  registers: [register],
});
const dbPoolAcquireTimeoutsGauge = new Gauge({
  name: 'breeze_db_pool_acquire_timeouts_total',
  help: 'Requests that hit DB_POOL_ACQUIRE_TIMEOUT_MS (#8229), by whether the timer fired late (event-loop stall); monotonic',
  labelNames: ['timer'] as const,
  registers: [register],
});
const dbPrologueDeadlineExpiriesGauge = new Gauge({
  name: 'breeze_db_prologue_deadline_expiries_total',
  help: 'RLS GUC prologue deadlines that expired, by whether the timer fired late (event-loop stall); monotonic',
  labelNames: ['timer'] as const,
  registers: [register],
});
```

Updater (next to `updateWedgedBackendMetrics`):

```ts
/** #8143. Read on scrape from the registered gate and the deadline totals. */
function updateDbPoolAdmissionMetrics(): void {
  const gate = getRequestPoolAdmission();
  const snapshot = gate?.snapshot();
  dbPoolAdmissionPermitsGauge.set(snapshot?.permits ?? -1);
  dbPoolAdmissionInUseGauge.set(snapshot?.inUse ?? -1);
  dbPoolAdmissionWaitingGauge.set(snapshot?.waiting ?? -1);
  dbPoolAdmissionAbandonedGauge.set(snapshot?.abandoned ?? -1);
  dbPoolAdmissionEffectivePermitsGauge.set(snapshot?.effectivePermits ?? -1);
  const totals = gate?.totals();
  dbPoolAdmissionCancelledWaitersGauge.set(totals?.cancelledWaiters ?? 0);
  dbPoolAdmissionAbandonedTotalGauge.set(totals?.abandoned ?? 0);
  for (const how of ABANDONED_RETURN_KINDS) {
    dbPoolAdmissionAbandonedReturnedGauge.labels(how).set(totals?.abandonedReturned[how] ?? 0);
  }
  const expiries = getDeadlineExpiryTotals();
  for (const timer of TIMER_LATENESS_VALUES) {
    dbPoolAcquireTimeoutsGauge.labels(timer).set(expiries.acquire[timer]);
    dbPrologueDeadlineExpiriesGauge.labels(timer).set(expiries.prologue[timer]);
  }
}
```

Call `updateDbPoolAdmissionMetrics();` at the end of `initializeRuntimeMetricDefaults()` (seeds every series from process start) and inside `updateRuntimeMetrics()` after `updateDbPoolHealthMetrics();`.

Alert — `monitoring/rules/breeze-rules.yml`, group `breeze-api-alerts`, after the `High4xxRate` rule:

```yaml
      # #8143. A permit held by an abandoned transaction normally returns within
      # seconds (the late statement completes and rolls back). One still held
      # after 3 minutes means a wedged backend the reclaimer has not cleared
      # (or reclaim is disabled): the effective pool is smaller than DB_POOL_MAX.
      - alert: DbPoolPermitsHeldByAbandonedTransactions
        expr: max by (job, instance) (breeze_db_pool_admission_abandoned{job=~"breeze-api.*"}) > 0
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "Abandoned DB transactions are holding pool permits on {{ $labels.instance }}"
          description: "{{ $value }} pool permit(s) held by transactions abandoned at their RLS prologue deadline for 3+ minutes. Check [db-wedged-backend] and [db-pool-admission] logs."
```

`apps/docs/src/content/docs/monitoring/alerts.mdx`, API Alerts table, after the `High4xxRate` row:

```md
| `DbPoolPermitsHeldByAbandonedTransactions` | warning | A pool permit held by an abandoned transaction for 3 minutes |
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/routes/metrics.test.ts src/services/workerEntrypointClosure.contract.test.ts
docker run --rm -v "$PWD/monitoring/rules:/rules:ro" --entrypoint promtool prom/prometheus check rules /rules/breeze-rules.yml
```
Expected: PASS; promtool prints `SUCCESS`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/metricsRuntime.ts apps/api/src/routes/metrics.test.ts monitoring/rules/breeze-rules.yml apps/docs/src/content/docs/monitoring/alerts.mdx
git commit -m "feat(metrics): pool admission, acquire/prologue expiry and abandoned-permit series + alert (#8143)"
```

---

### Task 9: Env knob, defaults and docs

**Files:**
- Modify: `.env.example` (#6048 block, including #8243's `DB_POOL_ACQUIRE_TIMEOUT_MS` lines)
- Modify: `docker-compose.yml`, `deploy/docker-compose.prod.yml` (next to #8243's `DB_POOL_ACQUIRE_TIMEOUT_MS` mapping)
- Modify: `apps/api/src/system/connections/internalEnvVars.ts`
- Modify: `apps/docs/src/content/docs/deploy/environment.mdx` (#8243's `DB_POOL_ACQUIRE_TIMEOUT_MS` row; the pool-health metrics table)

**Interfaces:** configuration only. `DB_POOL_ACQUIRE_TIMEOUT_MS` is #8243's knob; only its documented default changes (15000 → 10000, Task 2). One new knob: `DB_TIMER_LAG_GRACE_MS`. Guards: `envInventory.test.ts`, `config/envReadComposeCoverage.test.ts`.

- [ ] **Step 1: Run the guards to see them fail**

Run: `cd apps/api && npx vitest run src/system/connections/envInventory.test.ts src/config/envReadComposeCoverage.test.ts`
Expected: FAIL — unclassified / unmapped `DB_TIMER_LAG_GRACE_MS` (read by Task 1).

- [ ] **Step 2: Apply the edits**

`internalEnvVars.ts` — immediately after `DB_POOL_MAX`:

```ts
  DB_TIMER_LAG_GRACE_MS: 'database pool/watchdog tuning',
```

`docker-compose.yml` and `deploy/docker-compose.prod.yml` — after the `DB_POOL_ACQUIRE_TIMEOUT_MS` line in each:

```yaml
  # #8143 — one grace period for a DB budget timer that fired >= 1 s late.
  DB_TIMER_LAG_GRACE_MS: ${DB_TIMER_LAG_GRACE_MS:-}
```

`.env.example` — change `# DB_POOL_ACQUIRE_TIMEOUT_MS=15000` to `# DB_POOL_ACQUIRE_TIMEOUT_MS=10000`, add this line to the end of #8243's comment above it:

```
# Default 10000 so acquire + prologue (+ two lag graces) stays under the
# agent's 30 s HTTP timeout. A request still waiting for a permit when it
# expires never reaches the database (#8143).
```
and after it add:

```
#
# When a pool-acquire or prologue timer fires at least 1 s late (the event loop
# was stalled), it gets this one extra grace period before failing the request,
# so a reply that arrived during the stall is not thrown away (#8143). 0
# disables; capped at 10000.
# DB_TIMER_LAG_GRACE_MS=2000
```
In the "Reclaimer:" paragraph replace `# Reclaimer: after a prologue deadline expires, terminates the wedged backend` with `# Reclaimer: when a transaction abandoned by its prologue deadline still holds its pool permit one prologue budget later, terminates the wedged backend`.

`environment.mdx` — in #8243's `DB_POOL_ACQUIRE_TIMEOUT_MS` row change the default cell from `` `15000` `` to `` `10000` `` and append to its description: ``A request still waiting for a permit when the timeout hits never reaches the database.``. Add after it:

```md
| `DB_TIMER_LAG_GRACE_MS` | `2000` | | When the pool-acquire or connection-setup timer fires at least 1 s late because the API was overloaded, it gets this one extra grace period so a database reply that already arrived is not discarded. `0` disables; capped at `10000`. |
```

and in the pool-health metrics table (after `breeze_db_pool_health_probe_close_failures`):

```md
| `breeze_db_pool_admission_permits` / `_in_use` / `_waiting` | Request-transaction permits configured, held and waited for. `-1` when the process has no request pool. |
| `breeze_db_pool_admission_abandoned` / `_effective_permits` | Permits held by transactions abandoned at their connection-setup deadline, and the permits actually available (`permits − abandoned`). |
| `breeze_db_pool_admission_cancelled_waiters_total` | Requests that gave up waiting for a permit before ever reaching the database. |
| `breeze_db_pool_admission_abandoned_total`, `breeze_db_pool_admission_abandoned_returned_total{how="…"}` | Permits abandoned, and returned by `rollback` (the slow statement finished) or `connection-closed` (a wedged connection was reclaimed). |
| `breeze_db_pool_acquire_timeouts_total{timer="…"}`, `breeze_db_prologue_deadline_expiries_total{timer="…"}` | Pool-acquire and connection-setup timeouts; `timer="late"` means the API's event loop was stalled at the deadline. |
```

- [ ] **Step 3: Run the guards to verify they pass**

```bash
cd apps/api && npx vitest run src/system/connections/envInventory.test.ts src/config/envReadComposeCoverage.test.ts src/config/composeBindMounts.test.ts
```
Expected: PASS.

- [ ] **Step 4: Docs build check**

Run: `pnpm --filter @breeze/docs build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add .env.example docker-compose.yml deploy/docker-compose.prod.yml apps/api/src/system/connections/internalEnvVars.ts apps/docs/src/content/docs/deploy/environment.mdx
git commit -m "docs(config): DB_TIMER_LAG_GRACE_MS; DB_POOL_ACQUIRE_TIMEOUT_MS default 10s (#8143)"
```

---

### Task 10: Full verification, review, PR

**Files:** none new.

- [ ] **Step 1: Full API unit suite + typecheck**

```bash
cd apps/api && npx vitest run
cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit=$?"
```
Expected: all pass; `tsc exit=0`. Confirm the reported file count is the full suite, not a filtered subset.

- [ ] **Step 2: Integration contract suites**

```bash
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/dbPoolRecovery.integration.test.ts src/__tests__/integration/postgresJsBeginReservation.integration.test.ts src/__tests__/integration/accessContextGucs.integration.test.ts src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls
pnpm test-stack down
```
Expected: all pass. The full integration run is required because every request transaction now goes through the gate.

- [ ] **Step 3: One independent review round (high blast radius)**

Run `/pr-review-toolkit:review-pr` scoped to `apps/api/src/db/**`, `patches/postgres@3.4.9.patch`, `apps/api/src/services/metricsRuntime.ts`. Act only on confirmed, consequential findings. Re-review only if a fix touches `db/index.ts`, `db/prologueDeadline.ts` or the patch.

- [ ] **Step 4: Open the PR**

Branch `feature/8139-scaling/wave-8143` (feature-lifecycle: `get_feature_status` for #8139, then `start_wave` for #8143). The PR body includes `Closes #8143` and **no closing keyword for #8229 or #8243**; refer to them as "builds on #8243 (#8229)". Include: the root-cause list with [V]/[I] labels; the C1–C6 conflict table and what this PR changes in #8243's code (acquire default 15 s → 10 s, lag-tolerant clocks, `acquisition.signal`, deferred reclaim); the `[W04 grace comparison]` numbers from Task 7; the postgres.js patch and its repro; the new knob `DB_TIMER_LAG_GRACE_MS`; and the rollout note: after deploy, watch `breeze_db_pool_acquire_timeouts_total`, `breeze_db_pool_admission_cancelled_waiters_total`, `breeze_db_pool_admission_abandoned` and `breeze_db_prologue_deadline_expiries_total{timer}` on US. Rollback knobs: `DB_TIMER_LAG_GRACE_MS=0`, `DB_POOL_ACQUIRE_TIMEOUT_MS=15000` (#8243's original default), or a revert (no schema, no data).

```bash
gh pr create --base main --title "fix(db): pool admission gate, deferred abandoned-permit reclaim, stall recovery (#8143)" --body-file /tmp/pr-8143.md
grep -niE "(close[sd]?|fix(e[sd])?|resolve[sd]?) #(8229|8243)" /tmp/pr-8143.md && echo "REMOVE the closing keyword above" || echo "body ok"
```

- [ ] **Step 5: Hand-off**

Do not merge from this task. Report the PR URL, the CI state, and the owner decisions below.

---

## Owner decisions

1. **Acquire default 10 s (changes #8243's shipped 15 s).** With 15 s, acquire + prologue = 30 s, equal to the agent's HTTP timeout, so the agent can give up before the server answers. Recommendation: 10 s. Alternative: keep 15 s and lower the prologue to 10 s instead (prologues are milliseconds when healthy).
2. **Grace default (`DB_TIMER_LAG_GRACE_MS=2000`).** Fable: on, because it only triggers on a demonstrably late timer. Codex: off until a load comparison. Recommendation: ship on, re-decide after the W06 slow-loop storm compares on vs off.
3. **The postgres.js patch rides in this wave** (Task 5) because it is the "no double-use" criterion. Reporting it upstream is external communication and needs your go-ahead.
4. **Deferred to W08:** HTTP mapping of `DbPoolAcquireTimeoutError` to `503` + `Retry-After`, a bounded wait queue, and dropping waiters whose client disconnected.

## Self-review (run 2026-10-08, rebased onto #8243)

- **Spec coverage.** "Slot returns within a bound": permits return on settlement (Tasks 3/7); wedges via the deferred reclaim with a stated conditional bound (Task 4), tested end to end (Task 6 wedge test). "Pool max restored": `effective_permits` plus the three-distinct-backends check (Task 6). "Within 30 s of the stall ending": Task 6 first test. "No leaked connections / no double use": `pg_stat_activity` state check, same-pid GUC check (Task 6), driver patch (Task 5). Metrics for abandoned, reclaimed and effective size: Task 8. Deadline mis-measurement: fixed by #8243 for the pool queue (root cause 1); event-loop lateness handled by Tasks 1/2. Simulator: `agent/tools/agentsim/` is not on `origin/main` (`git ls-tree` at `864eafe525` finds no `agentsim` path), so the storm-level check is W06's.
- **Overlap with #8243 removed.** No second acquire knob, error class, timer split or acquire log: Task 2 extends #8243's `withAcquireAndPrologueDeadline` in place, Task 7 wraps it, Task 9 only touches its documented default.
- **Placeholder scan.** No TBD/TODO. Task 7 Step 1 tells the executor to grep for #8243's reclaim-at-expiry wiring assertion by pattern, because its exact name is whatever #8243 merges with; the replacement code is given in full.
- **Type consistency.** `PoolAcquisition.signal`, `PrologueDeadlineExpiry.timer`, `getDeadlineExpiryTotals()` shape `{ acquire, prologue }`, `PoolSlot.release(PoolSlotSettlement)`, `classifyPoolSlotSettlement`, `ABANDONED_RETURN_KINDS`, `TIMER_LATENESS_VALUES` and `getRequestPoolAdmission()` match across Tasks 2, 3, 4, 6, 7 and 8.
- **Review Focus.** Each of the five lines has a named test in its owning task (Tasks 3, 4, 5, 6, 7).
