---
tracking_issue: LanternOps/breeze#5573
---
# Service Deliverables W02: Sweep Worker, Ticket Integration, Key-Date Reminders, Auto-Evidence, MCP Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the W01 tables move on their own — a daily BullMQ sweep that materializes occurrences, opens deliverable tickets, generates auto-evidence report runs, marks misses and fires key-date reminders; an event subscriber that turns a real ticket resolution into a delivery record; a contract-cancelled hook; a move-org guard; SLA suppression for planned work; and MCP tools for deliverables and key dates.

**Architecture:** `jobs/deliverableWorker.ts` owns two BullMQ Workers created by one initializer — the `deliverable-jobs` queue (job `deliverable-sweep`, cron `18 5 * * *`) and the first-ever consumer of the previously-reserved `contract-events` queue. The sweep runs under `withSystemDbAccessContext`, one transaction per deliverable, and delegates every date decision to W01's pure `services/recurrence.ts` and every status decision to W01's pure `services/serviceDeliverableState.ts`. The four W01 stubs in `services/serviceDeliverableService.ts` get real bodies; nothing is renamed. A lazily-imported `deliverable-status` subscriber on `ticket.status_changed` closes the loop from the ticket side. Auto-evidence lives in its own module because it must reproduce the report scheduler's authority-reauthorization sequence.

**Tech Stack:** BullMQ + Redis, PostgreSQL + Drizzle ORM, Hono (no new routes), Zod (`@breeze/shared`), Vitest (unit with Drizzle mocks; integration on real Postgres), Anthropic tool definitions + agent-SDK `tool()` for MCP.

**Spec:** `docs/superpowers/specs/billing/2026-09-10-service-deliverables-portal-design.md` (approved 2026-09-10). Sections 5, 6, 7's D12 auto-evidence, 10's MCP tools for deliverables and key dates, 12's sweep error handling, 13's sweep integration list, and the W02 row of §14.

**Prior wave (the naming contract):** `docs/superpowers/plans/billing/2026-09-10-service-deliverables-w01-schema-core.md`. Every symbol W01 declared is reused **verbatim**: `planOccurrences`, `coveredPeriod`, `isInLeadWindow`, `isPastGrace`, `transition`, `InvalidTransitionError`, `DeliverableServiceError`, `DeliverableActor`, `OccurrenceView`, `materializeOccurrences`, `openOccurrence`, `markOccurrenceMissed`, `applyTicketStatusChange`. Renaming any of them breaks W03–W05.

## Global Constraints

- **No migrations in this wave.** Every table and column W02 touches was created by W01 (`service_deliverables`, `service_deliverable_occurrences`, `service_deliverable_evidence`, `organization_key_dates`, `tickets.work_kind`, `report_runs_id_report_id_uniq`). Writing DDL means the wave has been mis-scoped — stop and re-read W01.
- Background reads and writes run under `runOutsideDbContext(() => withSystemDbAccessContext(fn, '<label>'))` (`apps/api/src/db/index.ts:610`). **`withDbAccessContext` opens a real Postgres transaction** (`db/index.ts:525-575`), so one call is one transaction. "One transaction per deliverable" means one `withSystemDbAccessContext` call per deliverable, never one around the loop.
- Always pass a `label`. Under the tsup single-file bundle an anonymous worker arrow collapses to a bare `index` frame and the #3218 held-connection warning arrives unattributable.
- Fleet sweeps honour `buildAutomationEligibleOrgPredicate(column)` (`services/tenantStatus.ts:46`) — an archived tenant inside its purge countdown gets no tickets.
- **"Today" is UTC**, computed as the billing sweep does: `asOf.toISOString().slice(0, 10)` (`jobs/contractWorker.ts:48`).
- Date arithmetic only through `addMonthsClamped` / `addDaysISO` (`services/contractMath.ts:21`, `:62` — `addDaysISO` accepts negatives, verified at lines 62-70).
- Per-deliverable failures are logged with ids, `captureException`d and skipped; one failure never aborts the sweep (`contractWorker.ts:105-110` is the shape).
- Every `new Worker(...)` gets exactly one `attachWorkerObservability(worker, '<stableName>')`, and the attached-name set must equal the readiness manifest's declared consumers — `jobs/workerReadinessCoverage.test.ts:131-146` AST-scans both and diffs them.
- Run one test file as `cd apps/api && npx vitest run <path>`. Never `pnpm … test -- --run <path>` (the `--` is forwarded literally; vitest runs all 1,470 files in watch mode).
- Branch: `feature/<parent#>-service-deliverables/wave-<sub-issue#>`; PR body contains `Closes #<sub-issue#>`.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/src/jobs/scheduleRegistry.ts` | new daily-tier slot `'deliverable-sweep': '18 5 * * *'` |
| `apps/api/src/jobs/deliverableWorker.ts` (+ `.test.ts`) | `deliverable-jobs` queue/worker, `contract-events` consumer, `runDeliverableSweep` |
| `apps/api/src/services/workerRegistry.ts` | lazy `deliverableWorker` entry, `placement: 'global'` |
| `apps/api/src/jobs/workerReadinessManifest.ts` | `consumers('deliverableWorker', [...two names])` |
| `apps/api/src/services/serviceDeliverableService.ts` (+ `.test.ts`) | replace the four W01 stub bodies; sweep-shaped siblings |
| `apps/api/src/services/deliverableAutoEvidence.ts` (+ `.test.ts`) | D12 — reauthorized report run + evidence row + ticket note |
| `apps/api/src/services/orgKeyDateService.ts` (+ `.test.ts`) | `sweepKeyDateReminders`, `rollForwardAnnualKeyDates` |
| `apps/api/src/services/deliverableStatusSubscriber.ts` (+ `.test.ts`) | `ticket.status_changed` → occurrence transition |
| `apps/api/src/services/eventSubscriberIds.ts`, `eventSubscribers.ts` | register `deliverable-status` (lazy handler) |
| `apps/api/src/services/ticketService.ts` | `workKind` on create, SLA bypass, move-org guard |
| `apps/api/src/jobs/ticketSlaWorker.ts` | exclude non-`support` work kinds from the breach sweep |
| `apps/api/src/services/contractEvents.ts` | header correction: the bus is consumed now |
| `apps/api/src/services/aiToolsDeliverables.ts` (+ `.test.ts`) | `list_deliverables`, `manage_deliverables`, `manage_key_dates` |
| `apps/api/src/services/aiTools.ts`, `aiToolSchemas.ts`, `aiAgentSdkTools.ts`, `aiGuardrails.ts` | the four MCP registration sites |
| `apps/api/src/__tests__/integration/deliverableSweep.integration.test.ts` | real-Postgres proof of the whole loop |

---

### Task 1: Cron slot, worker plumbing, eligibility select

**Files:**
- Modify: `apps/api/src/jobs/scheduleRegistry.ts:97` (daily tier, hour 5)
- Create: `apps/api/src/jobs/deliverableWorker.ts`; Test: `apps/api/src/jobs/deliverableWorker.test.ts`
- Modify: `apps/api/src/services/workerRegistry.ts:1139-1146`; `apps/api/src/jobs/workerReadinessManifest.ts:155`; `apps/api/src/services/contractEvents.ts:5-9`

**Interfaces:**
- Consumes: `jobSchedule` (`scheduleRegistry.ts:169`), `getBullMQConnection` (`services/redis`), `attachWorkerObservability` (`jobs/workerObservability.ts:204`), `buildAutomationEligibleOrgPredicate` (`services/tenantStatus.ts:46`), `db`/`runOutsideDbContext`/`withSystemDbAccessContext`.
- Produces:

```ts
export interface DeliverableSweepResult { deliverables: number; materialized: number; opened: number; missed: number; autoEvidence: number; keyDateReminders: number; failed: number }
export function getDeliverableQueue(): Queue;
export function runDeliverableSweep(asOf?: Date): Promise<DeliverableSweepResult>;
export function createDeliverableWorker(): Worker;
export function createContractEventsWorker(): Worker;
export function scheduleDeliverableJobs(): Promise<void>;
export function initializeDeliverableWorkers(): Promise<void>;
export function shutdownDeliverableWorkers(): Promise<void>;
```

- [ ] **Step 1: Allocate the cron slot**

Daily tier is minutes ≡ 3 (mod 5). Hour 5 holds `8 5` (contract-billing-sweep), `38 5` (tdsynnex-sftp-sync), `58 5` (auth-browser-transition-cleanup); no sub-daily pattern fires on minute 18 (that lane is minutes 0, 7, 12, 15, 17, 22, 27, 32, 35, 37, 42, 47, 52, 57, plus `*/15` → 0/15/30/45). Insert in fire-time order after line 97:

```ts
  'contract-billing-sweep': '8 5 * * *',
  // Service deliverables W02 (spec §5.1). Daily tier, minute ≡ 3 (mod 5).
  // Ten minutes after the billing sweep so the two never hold the pool together.
  'deliverable-sweep': '18 5 * * *',
  'tdsynnex-sftp-sync': '38 5 * * *',
```

- [ ] **Step 2: Write the failing worker test**

`apps/api/src/jobs/deliverableWorker.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { captureExceptionMock } = vi.hoisted(() => ({ captureExceptionMock: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

const { resultQueue, capturedWhere } = vi.hoisted(() => ({ resultQueue: [] as unknown[][], capturedWhere: [] as unknown[] }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'orderBy', 'limit', 'innerJoin', 'update', 'set', 'insert', 'values', 'returning']) chain[m] = vi.fn(() => chain);
  chain.where = vi.fn((w: unknown) => { capturedWhere.push(w); return chain; });
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(resultQueue.shift() ?? []).then(r);
  return { db: chain, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() };
});

const { materializeMock, openMock, missMock, autoEvidenceMock, keyDateMock } = vi.hoisted(() => ({
  materializeMock: vi.fn(async () => [] as unknown[]), openMock: vi.fn(async () => 0),
  missMock: vi.fn(async () => 0), autoEvidenceMock: vi.fn(async () => 0), keyDateMock: vi.fn(async () => 0),
}));
vi.mock('../services/serviceDeliverableService', () => ({
  materializeOccurrences: materializeMock,
  openDueOccurrencesForDeliverable: openMock,
  markDueOccurrencesMissedForDeliverable: missMock,
  applyContractCancelledToDeliverables: vi.fn(),
}));
vi.mock('../services/deliverableAutoEvidence', () => ({ generateAutoEvidenceForDeliverable: autoEvidenceMock }));
vi.mock('../services/orgKeyDateService', () => ({ sweepKeyDateReminders: keyDateMock }));

import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { runDeliverableSweep } from './deliverableWorker';

const D = { id: 'd1', orgId: 'org1', name: 'Sign-in log review', cadence: 'monthly' as const,
  anchorDueDate: '2026-10-31', effectiveFrom: '2026-10-01', effectiveUntil: null,
  leadDays: 7, graceDays: 14, autoEvidenceReportId: null };
const AS_OF = new Date('2026-10-25T05:18:00Z');

describe('runDeliverableSweep', () => {
  beforeEach(() => { vi.clearAllMocks(); resultQueue.length = 0; capturedWhere.length = 0; });

  it('filters the eligible select on automation-eligible orgs and today', async () => {
    resultQueue.push([]);
    await runDeliverableSweep(AS_OF);
    const text = new PgDialect().sqlToQuery(capturedWhere[0] as SQL).sql;
    expect(text).toContain('automation_eligible_org');
    expect(text).toContain("'2026-10-25'");
  });

  it('runs every step for each deliverable and totals the counts', async () => {
    resultQueue.push([D]);
    materializeMock.mockResolvedValueOnce([{ id: 'o1' }, { id: 'o2' }]);
    openMock.mockResolvedValueOnce(2); missMock.mockResolvedValueOnce(1); keyDateMock.mockResolvedValueOnce(3);
    expect(await runDeliverableSweep(AS_OF)).toEqual({ deliverables: 1, materialized: 2, opened: 2, missed: 1, autoEvidence: 0, keyDateReminders: 3, failed: 0 });
    expect(autoEvidenceMock).not.toHaveBeenCalled();   // autoEvidenceReportId is null
  });

  it('runs auto-evidence only when a report is configured', async () => {
    resultQueue.push([{ ...D, autoEvidenceReportId: 'r1' }]);
    autoEvidenceMock.mockResolvedValueOnce(1);
    const res = await runDeliverableSweep(AS_OF);
    expect(autoEvidenceMock).toHaveBeenCalledWith({ ...D, autoEvidenceReportId: 'r1' }, '2026-10-25');
    expect(res.autoEvidence).toBe(1);
  });

  it('one failing deliverable does not abort the sweep', async () => {
    resultQueue.push([D, { ...D, id: 'd2' }]);
    materializeMock.mockRejectedValueOnce(new Error('boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await runDeliverableSweep(AS_OF);
      expect(res.failed).toBe(1);
      expect(res.deliverables).toBe(2);
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      expect(err).toHaveBeenCalledWith(expect.stringContaining('[DeliverableWorker]'), 'deliverableId=d1', 'orgId=org1', 'boom');
    } finally { err.mockRestore(); }
  });

  it('still sweeps key dates when no deliverable is eligible', async () => {
    resultQueue.push([]); keyDateMock.mockResolvedValueOnce(2);
    expect((await runDeliverableSweep(AS_OF)).keyDateReminders).toBe(2);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/api && npx vitest run src/jobs/deliverableWorker.test.ts`
Expected: FAIL — `Failed to resolve import "./deliverableWorker"`.

- [ ] **Step 4: Write the worker**

```ts
/**
 * Deliverable Worker
 *
 * Daily sweep (spec §5): for every active deliverable inside its effective
 * window, materialize missing occurrences, open the due ones as tickets,
 * generate auto-evidence, mark the ones past grace as missed; then key dates
 * for the whole fleet. Same singleton shape as contractWorker.ts.
 *
 * Also owns the FIRST consumer of the `contract-events` queue (spec §5.4).
 */
import { Queue, Worker } from 'bullmq';
import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { serviceDeliverables } from '../db/schema/serviceDeliverables';
import { buildAutomationEligibleOrgPredicate } from '../services/tenantStatus';
import {
  materializeOccurrences, openDueOccurrencesForDeliverable,
  markDueOccurrencesMissedForDeliverable, applyContractCancelledToDeliverables,
  type SweepDeliverable,
} from '../services/serviceDeliverableService';
import { generateAutoEvidenceForDeliverable } from '../services/deliverableAutoEvidence';
import { sweepKeyDateReminders } from '../services/orgKeyDateService';
import { CONTRACT_EVENTS_QUEUE, type ContractEvent } from '../services/contractEvents';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const DELIVERABLE_QUEUE = 'deliverable-jobs';
const DELIVERABLE_SWEEP_CRON = jobSchedule('deliverable-sweep');

let deliverableQueue: Queue | null = null;
let deliverableWorker: Worker | null = null;
let contractEventsWorker: Worker | null = null;

export interface DeliverableSweepResult {
  deliverables: number; materialized: number; opened: number;
  missed: number; autoEvidence: number; keyDateReminders: number; failed: number;
}

export function getDeliverableQueue(): Queue {
  if (!deliverableQueue) deliverableQueue = new Queue(DELIVERABLE_QUEUE, { connection: getBullMQConnection() });
  return deliverableQueue;
}

/**
 * Spec §5.2. Contract status is deliberately NOT consulted: generateDueInvoice
 * flips a contract to `expired` the day after its final invoice
 * (contractService.ts ~2013) while service runs on for months. The effective
 * window is the authority.
 */
export async function runDeliverableSweep(asOf: Date = new Date()): Promise<DeliverableSweepResult> {
  const today = asOf.toISOString().slice(0, 10);

  const due = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({
        id: serviceDeliverables.id, orgId: serviceDeliverables.orgId, name: serviceDeliverables.name,
        cadence: serviceDeliverables.cadence, anchorDueDate: serviceDeliverables.anchorDueDate,
        effectiveFrom: serviceDeliverables.effectiveFrom, effectiveUntil: serviceDeliverables.effectiveUntil,
        leadDays: serviceDeliverables.leadDays, graceDays: serviceDeliverables.graceDays,
        autoEvidenceReportId: serviceDeliverables.autoEvidenceReportId,
      })
      .from(serviceDeliverables)
      .where(and(
        eq(serviceDeliverables.active, true),
        lte(serviceDeliverables.effectiveFrom, today),
        or(isNull(serviceDeliverables.effectiveUntil), gte(serviceDeliverables.effectiveUntil, today)),
        buildAutomationEligibleOrgPredicate(serviceDeliverables.orgId)
      )), 'deliverableSweep.selectDue'));

  const res: DeliverableSweepResult = {
    deliverables: due.length, materialized: 0, opened: 0, missed: 0,
    autoEvidence: 0, keyDateReminders: 0, failed: 0,
  };
  // Spec §5.3 step 2: one warning per org per run, not per occurrence.
  const serviceOffWarned = new Set<string>();

  for (const d of due as SweepDeliverable[]) {
    try {
      res.materialized += (await materializeOccurrences(d.id, today)).length;
      res.opened += await openDueOccurrencesForDeliverable(d, today, serviceOffWarned);
      if (d.autoEvidenceReportId) res.autoEvidence += await generateAutoEvidenceForDeliverable(d, today);
      res.missed += await markDueOccurrencesMissedForDeliverable(d, today);
    } catch (err) {
      res.failed++;
      console.error('[DeliverableWorker] deliverable sweep failed', `deliverableId=${d.id}`, `orgId=${d.orgId}`,
        err instanceof Error ? err.message : String(err));
      captureException(err instanceof Error ? err : new Error(String(err)));
      continue;
    }
  }

  // Fleet-wide, not per deliverable: a key date needs no deliverable at all.
  try {
    res.keyDateReminders = await sweepKeyDateReminders(today);
  } catch (err) {
    res.failed++;
    console.error('[DeliverableWorker] key-date sweep failed', err instanceof Error ? err.message : String(err));
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
  return res;
}

export function createDeliverableWorker(): Worker {
  return new Worker(DELIVERABLE_QUEUE, async (job) => {
    if (job.name === 'deliverable-sweep') return runDeliverableSweep();
    throw new Error(`Unknown deliverable job: ${job.name}`);
  }, { connection: getBullMQConnection(), concurrency: 1 });
}

/**
 * Spec §5.4. `contract-events` was a reserved, unconsumed bus until now, so the
 * first deploy drains whatever sits in `wait`. That replay is safe by
 * construction: applyContractCancelledToDeliverables re-reads the contract and
 * applies nothing unless it is STILL cancelled, and only touches deliverables
 * whose effective_until is NULL.
 */
export function createContractEventsWorker(): Worker {
  return new Worker(CONTRACT_EVENTS_QUEUE, async (job) => {
    const event = job.data as ContractEvent;
    if (event.type !== 'contract.cancelled') return;
    await applyContractCancelledToDeliverables(event.contractId, new Date().toISOString().slice(0, 10));
  }, { connection: getBullMQConnection(), concurrency: 1 });
}

export async function scheduleDeliverableJobs(): Promise<void> {
  const queue = getDeliverableQueue();
  for (const job of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(job.key);
  await queue.add('deliverable-sweep', { type: 'deliverable-sweep' },
    { repeat: { pattern: DELIVERABLE_SWEEP_CRON }, removeOnComplete: { count: 10 }, removeOnFail: { count: 50 } });
  console.log('[DeliverableWorker] Scheduled daily deliverable sweep');
}

export async function initializeDeliverableWorkers(): Promise<void> {
  try {
    deliverableWorker = createDeliverableWorker();
    attachWorkerObservability(deliverableWorker, 'deliverableWorker');
    deliverableWorker.on('error', (e) => { console.error('[DeliverableWorker] Worker error:', e); captureException(e); });
    deliverableWorker.on('failed', (job, e) => { console.error(`[DeliverableWorker] Job ${job?.id} failed:`, e); captureException(e); });

    contractEventsWorker = createContractEventsWorker();
    attachWorkerObservability(contractEventsWorker, 'deliverableContractEventsWorker');
    contractEventsWorker.on('error', (e) => { console.error('[DeliverableWorker] contract-events worker error:', e); captureException(e); });

    await scheduleDeliverableJobs();
    console.log('[DeliverableWorker] Deliverable workers initialized');
  } catch (error) {
    console.error('[DeliverableWorker] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownDeliverableWorkers(): Promise<void> {
  if (deliverableWorker) { await deliverableWorker.close(); deliverableWorker = null; }
  if (contractEventsWorker) { await contractEventsWorker.close(); contractEventsWorker = null; }
  if (deliverableQueue) { await deliverableQueue.close(); deliverableQueue = null; }
  console.log('[DeliverableWorker] Deliverable workers shut down');
}
```

The five service functions this imports do not exist yet. Add them now as exported stubs that `throw new Error('not implemented')` in `serviceDeliverableService.ts`, `deliverableAutoEvidence.ts` and `orgKeyDateService.ts` (the unit test mocks them all); Tasks 2–7 replace the bodies, never the names. `SweepDeliverable` is declared in Task 2.

- [ ] **Step 5: Wire startup**

`apps/api/src/services/workerRegistry.ts`, directly after the `contractWorker` entry (lines 1139-1146):

```ts
  {
    // Service deliverables W02 (spec §5.1). Two Workers, one initializer.
    // 'global' because workerEntrypointClosure.contract.test.ts says so — if it
    // reports the closure reaching routes/agentWs.ts, flip to 'socket-owner',
    // never loosen the test.
    name: 'deliverableWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/deliverableWorker');
      return { init: m.initializeDeliverableWorkers, shutdown: m.shutdownDeliverableWorkers };
    },
  },
```

`apps/api/src/jobs/workerReadinessManifest.ts`, directly after `consumers('contractWorker'),` (line 155):

```ts
  // ONE initializer constructing TWO Workers, so both stable names are declared.
  // They must match the attachWorkerObservability strings character for
  // character — workerReadinessCoverage.test.ts diffs the two sets.
  consumers('deliverableWorker', ['deliverableWorker', 'deliverableContractEventsWorker']),
```

- [ ] **Step 6: Correct the now-stale `contract-events` header**

Replace `apps/api/src/services/contractEvents.ts:5-9` with:

```ts
// `contract-events` carries contract lifecycle events. Consumed since the
// service-deliverables wave (jobs/deliverableWorker.ts's contract-events
// Worker), which acts on `contract.cancelled` and ignores every other type.
// Delivery is still best-effort: emitContractEvent never throws, so a Redis
// hiccup during a cancel drops the event and the MSP closes the deliverable's
// effective window by hand.
```

- [ ] **Step 7: Run the unit test and the contract suites**

Run: `cd apps/api && npx vitest run src/jobs/deliverableWorker.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/workerEntrypointClosure.contract.test.ts src/jobs/workerReadinessCoverage.test.ts src/jobs/workerReadinessManifest.test.ts`
Expected: all PASS. `scheduleRegistry.contract.test.ts` fails on a slot collision; `workerReadinessCoverage.test.ts` fails if an attach name differs from the manifest.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/jobs/scheduleRegistry.ts apps/api/src/jobs/deliverableWorker.ts apps/api/src/jobs/deliverableWorker.test.ts apps/api/src/services/workerRegistry.ts apps/api/src/jobs/workerReadinessManifest.ts apps/api/src/services/contractEvents.ts
git commit -m "feat(deliverables): deliverable sweep worker plumbing and cron slot (W02)"
```

---

### Task 2: `materializeOccurrences` and the miss step

**Files:**
- Modify: `apps/api/src/services/serviceDeliverableService.ts` (replace the `materializeOccurrences` / `markOccurrenceMissed` stubs)
- Test: `apps/api/src/services/serviceDeliverableService.test.ts` (append)

**Interfaces:**
- Consumes: `planOccurrences` (`services/recurrence.ts`, W01 Task 5); `serviceDeliverables`, `serviceDeliverableOccurrences` (W01 Task 3).
- Produces:

```ts
export interface SweepDeliverable {
  id: string; orgId: string; name: string;
  cadence: 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'one_time';
  anchorDueDate: string; effectiveFrom: string; effectiveUntil: string | null;
  leadDays: number; graceDays: number; autoEvidenceReportId: string | null;
}
export function materializeOccurrences(deliverableId: string, today: string): Promise<ServiceDeliverableOccurrenceRow[]>;  // W01 signature
export function markOccurrenceMissed(occurrenceId: string): Promise<void>;                                                // W01 signature
export function markDueOccurrencesMissedForDeliverable(d: SweepDeliverable, today: string): Promise<number>;
```

- [ ] **Step 1: Write the failing tests**

Append to `serviceDeliverableService.test.ts`, reusing the `dbMocks` harness W01 Task 8 established (extend it so `values()` pushes into `dbMocks.inserted` and `set()` into `dbMocks.updated` if it does not already):

```ts
const DEF = { id: 'd1', orgId: 'org1', name: 'Sign-in log review', cadence: 'monthly',
  effectiveFrom: '2026-10-01', effectiveUntil: null, leadDays: 7, graceDays: 14 };

describe('materializeOccurrences (spec §5.3 step 1)', () => {
  beforeEach(() => { dbMocks.rows.length = 0; dbMocks.inserted.length = 0; });

  it('inserts one row per planned due date with the name snapshot', async () => {
    dbMocks.rows.push([{ ...DEF, anchorDueDate: '2026-10-31' }]);
    dbMocks.rows.push([]);                      // existing due dates: none
    dbMocks.rows.push([{ id: 'o1' }]);          // insert ... returning
    expect(await materializeOccurrences('d1', '2026-10-25')).toHaveLength(1);
    expect((dbMocks.inserted.at(-1) as Array<Record<string, unknown>>)[0]).toMatchObject({
      orgId: 'org1', deliverableId: 'd1', nameSnapshot: 'Sign-in log review',
      periodStart: '2026-10-01', periodEnd: '2026-10-31',
      dueAt: '2026-10-31', originalDueAt: '2026-10-31', status: 'scheduled',
    });
  });

  it('inserts catch-up occurrences past grace directly as missed, capped at 12', async () => {
    dbMocks.rows.push([{ ...DEF, anchorDueDate: '2026-01-31', effectiveFrom: '2026-01-01' }]);
    dbMocks.rows.push([]);
    dbMocks.rows.push([{ id: 'o1' }]);
    await materializeOccurrences('d1', '2026-10-25');
    const values = dbMocks.inserted.at(-1) as Array<Record<string, unknown>>;
    expect(values.length).toBeLessThanOrEqual(12);
    expect(values[0]).toMatchObject({ dueAt: '2026-01-31', status: 'missed' });
    expect(values.at(-1)).toMatchObject({ status: 'scheduled' });
  });

  it('is a no-op when every due date is already materialized', async () => {
    dbMocks.rows.push([{ ...DEF, anchorDueDate: '2026-10-31' }]);
    dbMocks.rows.push([{ dueAt: '2026-10-31' }]);
    expect(await materializeOccurrences('d1', '2026-10-25')).toEqual([]);
    expect(dbMocks.inserted).toHaveLength(0);
  });

  it('throws NOT_FOUND for a deliverable that no longer exists', async () => {
    dbMocks.rows.push([]);
    await expect(materializeOccurrences('gone', '2026-10-25')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('markDueOccurrencesMissedForDeliverable (spec §5.3 step 4)', () => {
  it('moves rows past grace to missed and never touches the ticket', async () => {
    dbMocks.rows.length = 0; dbMocks.rows.push([{ id: 'o1' }, { id: 'o2' }]);
    const n = await markDueOccurrencesMissedForDeliverable(
      { ...DEF, cadence: 'monthly', anchorDueDate: '2026-01-31', autoEvidenceReportId: null } as never, '2026-10-25');
    expect(n).toBe(2);
    const patch = dbMocks.updated.at(-1) as Record<string, unknown>;
    expect(patch).toMatchObject({ status: 'missed' });
    expect(patch).not.toHaveProperty('ticketId');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/serviceDeliverableService.test.ts`
Expected: FAIL — `not implemented (W02)` from the W01 stubs.

- [ ] **Step 3: Implement**

```ts
export interface SweepDeliverable {
  id: string; orgId: string; name: string; cadence: Cadence;
  anchorDueDate: string; effectiveFrom: string; effectiveUntil: string | null;
  leadDays: number; graceDays: number; autoEvidenceReportId: string | null;
}

/** Spec §5.3 step 1. System caller — run inside withSystemDbAccessContext. */
export async function materializeOccurrences(
  deliverableId: string, today: string
): Promise<ServiceDeliverableOccurrenceRow[]> {
  const [d] = await db
    .select({
      id: serviceDeliverables.id, orgId: serviceDeliverables.orgId, name: serviceDeliverables.name,
      cadence: serviceDeliverables.cadence, anchorDueDate: serviceDeliverables.anchorDueDate,
      effectiveFrom: serviceDeliverables.effectiveFrom, effectiveUntil: serviceDeliverables.effectiveUntil,
      leadDays: serviceDeliverables.leadDays, graceDays: serviceDeliverables.graceDays,
    })
    .from(serviceDeliverables).where(eq(serviceDeliverables.id, deliverableId)).limit(1);
  if (!d) throw new DeliverableServiceError('Not found', 404, 'NOT_FOUND');

  const existing = await db
    .select({ dueAt: serviceDeliverableOccurrences.dueAt })
    .from(serviceDeliverableOccurrences)
    .where(eq(serviceDeliverableOccurrences.deliverableId, deliverableId));

  const plan = planOccurrences({
    anchorDueDate: d.anchorDueDate, cadence: d.cadence as Cadence,
    effectiveFrom: d.effectiveFrom, effectiveUntil: d.effectiveUntil,
    leadDays: d.leadDays, graceDays: d.graceDays, today,
    existingDueDates: existing.map((e) => e.dueAt),
  });
  if (plan.length === 0) return [];

  return db.insert(serviceDeliverableOccurrences)
    .values(plan.map((p) => ({
      orgId: d.orgId, deliverableId: d.id,
      // Spec §4.2: the name at materialization. A later rename never rewrites history.
      nameSnapshot: d.name,
      periodStart: p.periodStart, periodEnd: p.periodEnd,
      dueAt: p.dueAt, originalDueAt: p.dueAt, status: p.initialStatus,
    })))
    // UNIQUE (deliverable_id, period_start) is the claim; a concurrent sweep
    // loses silently rather than raising 23505 and failing the deliverable.
    .onConflictDoNothing({ target: [serviceDeliverableOccurrences.deliverableId, serviceDeliverableOccurrences.periodStart] })
    .returning();
}

/** Spec §5.3 step 4, single-row form. Kept because W03/W05 call it directly. */
export async function markOccurrenceMissed(occurrenceId: string): Promise<void> {
  await db.update(serviceDeliverableOccurrences)
    .set({ status: 'missed', updatedAt: new Date() })
    .where(and(eq(serviceDeliverableOccurrences.id, occurrenceId),
      inArray(serviceDeliverableOccurrences.status, ['open', 'awaiting_evidence'])));
}

/**
 * Spec §5.3 step 4, sweep form. The ticket is deliberately untouched: a missed
 * deliverable's work may still be in flight, and closing its ticket would
 * destroy that signal.
 */
export async function markDueOccurrencesMissedForDeliverable(d: SweepDeliverable, today: string): Promise<number> {
  const cutoff = addDaysISO(today, -d.graceDays);   // dueAt < cutoff ⇔ dueAt + grace < today
  const rows = await db.update(serviceDeliverableOccurrences)
    .set({ status: 'missed', updatedAt: new Date() })
    .where(and(
      eq(serviceDeliverableOccurrences.deliverableId, d.id),
      inArray(serviceDeliverableOccurrences.status, ['open', 'awaiting_evidence']),
      lt(serviceDeliverableOccurrences.dueAt, cutoff)
    ))
    .returning({ id: serviceDeliverableOccurrences.id });
  return rows.length;
}
```

Add `lt`, `inArray` to the drizzle import, `addDaysISO` to `./contractMath`, and `planOccurrences`, `type Cadence` to `./recurrence`.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/serviceDeliverableService.test.ts src/services/recurrence.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/serviceDeliverableService.ts apps/api/src/services/serviceDeliverableService.test.ts
git commit -m "feat(deliverables): materialize occurrences and mark misses in the sweep (W02)"
```

---

### Task 3: Open due occurrences as deliverable tickets, with SLA suppressed

**Files:**
- Modify: `apps/api/src/services/ticketService.ts` (`BaseCreateTicketInput` at 460-481; SLA resolution and insert at 661-703)
- Modify: `apps/api/src/jobs/ticketSlaWorker.ts:70-84` (the `due` CTE)
- Modify: `apps/api/src/services/serviceDeliverableService.ts` (replace the `openOccurrence` stub; add the sweep form)
- Test: `apps/api/src/services/ticketService.workKind.test.ts` (new); `serviceDeliverableService.test.ts` (append)

**Interfaces:**
- Consumes: `createTicket` (`ticketService.ts:498`), `TicketServiceError` (`:64`), `isInLeadWindow` (`recurrence.ts`).
- Produces:

```ts
interface BaseCreateTicketInput { /* …existing… */ workKind?: 'support' | 'deliverable' | 'project_task' }
export function resolveSlaTargetsForWorkKind(workKind: 'support'|'deliverable'|'project_task', targets: { responseMinutes: number|null; resolutionMinutes: number|null }): { responseMinutes: number|null; resolutionMinutes: number|null };
export function openOccurrence(occurrenceId: string, ticketId: string | null): Promise<void>;   // W01 signature
export function periodLabel(cadence: Cadence, periodEnd: string): string;
export function openDueOccurrencesForDeliverable(d: SweepDeliverable, today: string, serviceOffWarned: Set<string>): Promise<number>;
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/ticketService.workKind.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveSlaTargetsForWorkKind } from './ticketService';

describe('SLA defaults by work kind (spec §4.8, D3)', () => {
  const targets = { responseMinutes: 60, resolutionMinutes: 480 };
  it('keeps the resolved SLA for support work', () => {
    expect(resolveSlaTargetsForWorkKind('support', targets)).toEqual(targets);
  });
  it('drops BOTH SLA minutes for deliverable work', () => {
    // The SLA worker clocks from created_at, so a 7-day-lead deliverable ticket
    // would breach before the work was due.
    expect(resolveSlaTargetsForWorkKind('deliverable', targets)).toEqual({ responseMinutes: null, resolutionMinutes: null });
  });
  it('drops both for the reserved project_task kind too', () => {
    expect(resolveSlaTargetsForWorkKind('project_task', targets)).toEqual({ responseMinutes: null, resolutionMinutes: null });
  });
});
```

Append to `serviceDeliverableService.test.ts` (add `createTicketMock` to the file's `vi.hoisted` block and `vi.mock('./ticketService', () => ({ createTicket: createTicketMock }))`):

```ts
const SD = { id: 'd1', orgId: 'org1', name: 'Sign-in log review', cadence: 'monthly' as const,
  anchorDueDate: '2026-10-31', effectiveFrom: '2026-10-01', effectiveUntil: null,
  leadDays: 7, graceDays: 14, autoEvidenceReportId: null };
const OCC = { id: 'o1', nameSnapshot: 'Sign-in log review', periodStart: '2026-10-01', periodEnd: '2026-10-31', dueAt: '2026-10-31' };
/** candidates, claim, config, partner pre-resolve */
const seedOpen = (claim: unknown[], cfg: Record<string, unknown>, ok: Record<string, boolean>) => {
  dbMocks.rows.push([OCC], claim, [cfg], [ok]);
};

describe('openDueOccurrencesForDeliverable (spec §5.3 step 2)', () => {
  beforeEach(() => { dbMocks.rows.length = 0; dbMocks.updated.length = 0; createTicketMock.mockReset(); });

  it('creates an SLA-free deliverable ticket and links it to the claimed occurrence', async () => {
    seedOpen([{ id: 'o1' }], { ownerUserId: 'u1', ticketCategoryId: 'c1', description: 'Review sign-in logs' }, { ownerOk: true, categoryOk: true });
    createTicketMock.mockResolvedValue({ id: 't1' });
    expect(await openDueOccurrencesForDeliverable(SD, '2026-10-25', new Set())).toBe(1);
    expect(createTicketMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org1', source: 'api', workKind: 'deliverable',
      subject: 'Sign-in log review — Oct 2026',
      dueDate: new Date('2026-10-31T00:00:00.000Z'), assigneeId: 'u1', categoryId: 'c1',
    }), expect.objectContaining({ userId: expect.any(String) }));
    expect(dbMocks.updated.at(-1)).toMatchObject({ ticketId: 't1' });
  });

  it('leaves the occurrence open with a null ticket when Service Management is off, warning once per org', async () => {
    seedOpen([{ id: 'o1' }], { ownerUserId: null, ticketCategoryId: null, description: null }, { ownerOk: true, categoryOk: true });
    createTicketMock.mockRejectedValue(Object.assign(new Error('off'), { code: 'service_management_off' }));
    const warned = new Set<string>();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await openDueOccurrencesForDeliverable(SD, '2026-10-25', warned)).toBe(1);  // the occurrence IS open
      expect(dbMocks.updated.at(-1)).not.toHaveProperty('ticketId');
      expect(warn).toHaveBeenCalledTimes(1);
      seedOpen([{ id: 'o1' }], { ownerUserId: null, ticketCategoryId: null, description: null }, { ownerOk: true, categoryOk: true });
      await openDueOccurrencesForDeliverable(SD, '2026-10-25', warned);
      expect(warn).toHaveBeenCalledTimes(1);                                             // once per org per run
    } finally { warn.mockRestore(); }
  });

  it('rethrows any other ticket failure so the claim rolls back and retries tomorrow', async () => {
    seedOpen([{ id: 'o1' }], { ownerUserId: null, ticketCategoryId: null, description: null }, { ownerOk: true, categoryOk: true });
    createTicketMock.mockRejectedValue(new Error('connection reset'));
    await expect(openDueOccurrencesForDeliverable(SD, '2026-10-25', new Set())).rejects.toThrow('connection reset');
  });

  it('drops an owner or category no longer in the org partner instead of stalling forever', async () => {
    seedOpen([{ id: 'o1' }], { ownerUserId: 'u-gone', ticketCategoryId: 'c-gone', description: null }, { ownerOk: false, categoryOk: false });
    createTicketMock.mockResolvedValue({ id: 't1' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await openDueOccurrencesForDeliverable(SD, '2026-10-25', new Set());
      const input = createTicketMock.mock.calls[0]![0] as Record<string, unknown>;
      expect(input.assigneeId).toBeUndefined();
      expect(input.categoryId).toBeUndefined();
    } finally { warn.mockRestore(); }
  });

  it('skips an occurrence another sweep already claimed', async () => {
    dbMocks.rows.push([OCC], []);                          // claim returned 0 rows
    expect(await openDueOccurrencesForDeliverable(SD, '2026-10-25', new Set())).toBe(0);
    expect(createTicketMock).not.toHaveBeenCalled();
  });

  it('never opens an occurrence outside its lead window', async () => {
    dbMocks.rows.push([{ ...OCC, dueAt: '2026-12-31' }]);
    expect(await openDueOccurrencesForDeliverable(SD, '2026-10-25', new Set())).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/ticketService.workKind.test.ts src/services/serviceDeliverableService.test.ts`
Expected: FAIL — `resolveSlaTargetsForWorkKind` and `openDueOccurrencesForDeliverable` are not exported.

- [ ] **Step 3: Add `workKind` and the SLA bypass to `createTicket`**

In `BaseCreateTicketInput`, after `formResponses?` (line 480):

```ts
  /**
   * Spec §4.8 (D3/D14). Planned work is typed, not tagged. Defaults to
   * 'support'; only the deliverable sweep and the key-date reminder set
   * anything else today. Non-'support' gets NO SLA — see below.
   */
  workKind?: 'support' | 'deliverable' | 'project_task';
```

Above `createTicket`:

```ts
/**
 * Planned work carries no SLA. The SLA worker clocks from `created_at`
 * (jobs/ticketSlaWorker.ts:79), so a deliverable ticket opened `lead_days`
 * before its due date would breach before the work was due. This is the SINGLE
 * place category/org/partner defaults are dropped; the worker's own
 * `work_kind = 'support'` predicate is defence in depth for older rows.
 */
export function resolveSlaTargetsForWorkKind(
  workKind: 'support' | 'deliverable' | 'project_task',
  targets: { responseMinutes: number | null; resolutionMinutes: number | null }
): { responseMinutes: number | null; resolutionMinutes: number | null } {
  return workKind === 'support' ? targets : { responseMinutes: null, resolutionMinutes: null };
}
```

Immediately after the `resolveSlaTargets({...})` call (lines 667-675):

```ts
  const workKind = input.workKind ?? 'support';
  const effectiveSla = resolveSlaTargetsForWorkKind(workKind, slaTargets);
```

and in `insertValues` replace lines 699-700 and add the column:

```ts
    responseSlaMinutes: effectiveSla.responseMinutes,
    resolutionSlaMinutes: effectiveSla.resolutionMinutes,
    workKind,
```

- [ ] **Step 4: Suppress SLA breaches for non-support work**

In `apps/api/src/jobs/ticketSlaWorker.ts`, add one predicate to the `due` CTE between lines 74 and 75:

```sql
      WHERE status IN ('new', 'open')
        -- Spec §4.8: planned work has a due date, not an SLA. Rows written
        -- before tickets.work_kind shipped default to 'support', so this
        -- narrows nothing that used to be swept.
        AND work_kind = 'support'
        AND sla_paused_at IS NULL
```

- [ ] **Step 5: Implement the open step**

```ts
/** Spec §5.3 step 2, single-row form. System caller. */
export async function openOccurrence(occurrenceId: string, ticketId: string | null): Promise<void> {
  await db.update(serviceDeliverableOccurrences)
    .set({ status: 'open', ...(ticketId ? { ticketId } : {}), updatedAt: new Date() })
    .where(and(eq(serviceDeliverableOccurrences.id, occurrenceId), eq(serviceDeliverableOccurrences.status, 'scheduled')));
}

/** "Oct 2026" | "Q4 2026" | "H2 2026" | "2026" — the period label in the subject. */
export function periodLabel(cadence: Cadence, periodEnd: string): string {
  const [y, m] = periodEnd.split('-').map(Number) as [number, number];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (cadence === 'annual') return String(y);
  if (cadence === 'semiannual') return `H${m <= 6 ? 1 : 2} ${y}`;
  if (cadence === 'quarterly') return `Q${Math.ceil(m / 3)} ${y}`;
  return `${MONTHS[m - 1]} ${y}`;                          // monthly and one_time
}

/**
 * Synthetic actor: only ever written to audit_logs.actor_id, which is NOT NULL
 * with no FK to users (precedent: inboundEmailService.ts:31). createTicket
 * writes no `tickets` column from actor.userId.
 */
const DELIVERABLE_SWEEP_ACTOR = { userId: '00000000-0000-0000-0000-000000000000', name: 'Service deliverables' } as const;

/**
 * Spec §5.3 step 2. One transaction per occurrence: the claim UPDATE and the
 * ticket creation commit or roll back together, so a crash between them cannot
 * strand an `open` occurrence with no ticket and no retry.
 */
export async function openDueOccurrencesForDeliverable(
  d: SweepDeliverable, today: string, serviceOffWarned: Set<string>
): Promise<number> {
  const candidates = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({
        id: serviceDeliverableOccurrences.id, nameSnapshot: serviceDeliverableOccurrences.nameSnapshot,
        periodStart: serviceDeliverableOccurrences.periodStart, periodEnd: serviceDeliverableOccurrences.periodEnd,
        dueAt: serviceDeliverableOccurrences.dueAt,
      })
      .from(serviceDeliverableOccurrences)
      .where(and(eq(serviceDeliverableOccurrences.deliverableId, d.id), eq(serviceDeliverableOccurrences.status, 'scheduled'))),
    'deliverableSweep.selectScheduled'));

  let opened = 0;
  for (const occ of candidates) {
    if (!isInLeadWindow(occ.dueAt, d.leadDays, today)) continue;
    opened += await runOutsideDbContext(() => withSystemDbAccessContext(
      () => openOneOccurrence(d, occ, serviceOffWarned), 'deliverableSweep.openOccurrence'));
  }
  return opened;
}

async function openOneOccurrence(
  d: SweepDeliverable,
  occ: { id: string; nameSnapshot: string; periodStart: string; periodEnd: string; dueAt: string },
  serviceOffWarned: Set<string>
): Promise<number> {
  // Claim first: 0 rows means a concurrent sweep won and already has the ticket.
  const claimed = await db.update(serviceDeliverableOccurrences)
    .set({ status: 'open', updatedAt: new Date() })
    .where(and(eq(serviceDeliverableOccurrences.id, occ.id), eq(serviceDeliverableOccurrences.status, 'scheduled')))
    .returning({ id: serviceDeliverableOccurrences.id });
  if (claimed.length === 0) return 0;

  const [cfg] = await db.select({
      ownerUserId: serviceDeliverables.ownerUserId,
      ticketCategoryId: serviceDeliverables.ticketCategoryId,
      description: serviceDeliverables.description,
    }).from(serviceDeliverables).where(eq(serviceDeliverables.id, d.id)).limit(1);

  const { ownerUserId, ticketCategoryId } =
    await resolveTicketTargets(d.orgId, cfg?.ownerUserId ?? null, cfg?.ticketCategoryId ?? null);

  let ticketId: string | null = null;
  try {
    const ticket = await createTicket({
      orgId: d.orgId, source: 'api', workKind: 'deliverable',
      subject: `${occ.nameSnapshot} — ${periodLabel(d.cadence, occ.periodEnd)}`,
      description: cfg?.description ?? undefined,
      dueDate: new Date(`${occ.dueAt}T00:00:00.000Z`),
      assigneeId: ownerUserId ?? undefined,
      categoryId: ticketCategoryId ?? undefined,
    }, DELIVERABLE_SWEEP_ACTOR);
    ticketId = ticket.id;
  } catch (err) {
    // Spec §5.3 step 2: an `off` partner still gets the occurrence, fulfilled by
    // hand. Anything else rolls this transaction back — the claim is released
    // and the occurrence retries on the next run rather than being stranded.
    if ((err as { code?: string }).code !== 'service_management_off') throw err;
    if (!serviceOffWarned.has(d.orgId)) {
      serviceOffWarned.add(d.orgId);
      console.warn('[deliverables] Service Management is off for this partner — occurrences opened without tickets',
        `orgId=${d.orgId}`, `deliverableId=${d.id}`);
    }
    return 1;
  }

  await db.update(serviceDeliverableOccurrences)
    .set({ ticketId, updatedAt: new Date() })
    .where(eq(serviceDeliverableOccurrences.id, occ.id));
  return 1;
}

/**
 * An owner who left the partner, or a category deleted since, would make
 * createTicket throw ASSIGNEE_WRONG_PARTNER / CATEGORY_NOT_FOUND on every run
 * and stall this deliverable permanently and silently. Pre-resolve both against
 * the org's partner and drop whichever no longer holds, loudly.
 */
async function resolveTicketTargets(
  orgId: string, ownerUserId: string | null, ticketCategoryId: string | null
): Promise<{ ownerUserId: string | null; ticketCategoryId: string | null }> {
  if (!ownerUserId && !ticketCategoryId) return { ownerUserId: null, ticketCategoryId: null };
  const [row] = await db.select({
      ownerOk: sql<boolean>`EXISTS (SELECT 1 FROM ${users} u JOIN ${organizations} o ON o.partner_id = u.partner_id
        WHERE u.id = ${ownerUserId}::uuid AND o.id = ${orgId}::uuid)`,
      categoryOk: sql<boolean>`EXISTS (SELECT 1 FROM ${ticketCategories} tc JOIN ${organizations} o ON o.partner_id = tc.partner_id
        WHERE tc.id = ${ticketCategoryId}::uuid AND o.id = ${orgId}::uuid)`,
    }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const okOwner = ownerUserId !== null && row?.ownerOk === true;
  const okCategory = ticketCategoryId !== null && row?.categoryOk === true;
  if (ownerUserId && !okOwner) console.warn('[deliverables] dropping owner no longer in the org partner', `orgId=${orgId}`, `userId=${ownerUserId}`);
  if (ticketCategoryId && !okCategory) console.warn('[deliverables] dropping ticket category no longer in the org partner', `orgId=${orgId}`, `categoryId=${ticketCategoryId}`);
  return { ownerUserId: okOwner ? ownerUserId : null, ticketCategoryId: okCategory ? ticketCategoryId : null };
}
```

Add `createTicket` to the `./ticketService` import and `isInLeadWindow` to `./recurrence`.

- [ ] **Step 6: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/ticketService.workKind.test.ts src/services/serviceDeliverableService.test.ts src/jobs/ticketSlaWorker.test.ts src/services/ticketService.test.ts && npx tsc --noEmit`
Expected: PASS. `ticketService.test.ts` is included because `insertValues` changed — an existing shape assertion there needs `workKind: 'support'` added.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.workKind.test.ts apps/api/src/jobs/ticketSlaWorker.ts apps/api/src/services/serviceDeliverableService.ts apps/api/src/services/serviceDeliverableService.test.ts
git commit -m "feat(deliverables): open occurrences as SLA-free deliverable tickets (W02)"
```

---

### Task 4: Auto-evidence report runs (spec D12, §5.3 step 3)

**Files:**
- Create: `apps/api/src/services/deliverableAutoEvidence.ts`; Test: `apps/api/src/services/deliverableAutoEvidence.test.ts`

**Interfaces:**
- Consumes: `generateReport` (`services/reportGenerationService.ts:743`), `assertReportExecutionPreflight` (`:232`), `decodeSiteScope` (`services/siteScope.ts:377`), `resolveLiveReportAuthority` (`:1052`), `persistedSiteScopeValues` (`:451`), `intersectSiteScopes`, `siteScopeFingerprint` (same module), `reports`/`reportRuns` (`db/schema/reports.ts:96`), `serviceDeliverableEvidence`, `ticketComments` (`db/schema/portal.ts:181-205`).
- Produces:

```ts
export const AUTO_EVIDENCE_TICKET_NOTE = 'Report attached, review and resolve';
export type AutoEvidenceOutcome =
  | { ok: true; reportRunId: string }
  | { ok: false; reason: 'already_attached' | 'not_due' | 'definition_not_found'
      | 'system_principal_definition' | 'portal_user_principal_definition'
      | 'scope_unverifiable' | 'scope_no_intersection' | 'scope_empty' | 'generation_failed' };
export function generateAutoEvidenceForDeliverable(d: SweepDeliverable, today: string): Promise<number>;
export function generateAutoEvidenceForOccurrence(args: {
  orgId: string; occurrenceId: string; ticketId: string | null; reportId: string; dueAt: string; today: string;
}): Promise<AutoEvidenceOutcome>;
```

**Design constraint the implementer must not "simplify" away.** `ReportExecutionAuthority` (`siteScope.ts:64-81`) has exactly two arms, `'user'` and `'portal_user'`; `SystemReportExecutionAuthority` (`:91-96`) is a **deliberately separate** type and `assertExecutableAuthority` (`reportGenerationService.ts:170`) ends in `const exhaustive: never = authority`. Do **not** widen that union and do **not** forge a `'user'` authority. Do exactly what `jobs/reportScheduleWorker.ts:546-626` does: refuse a non-user-principal definition, decode its persisted scope, re-resolve the owning user's **live** authority, intersect, preflight. The run row is then stamped `requested_by_kind: 'system'` with both requester ids NULL — which is precisely what the `report_runs_requested_by_shape_chk` system arm requires (`migrations/2026-10-08-100100-portal-report-self-service.sql:78-98`) — while `execution_scope_*` records whose scope actually ran. The two column families answer different questions: who could see the data, and who asked.

- [ ] **Step 1: Write the failing tests**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows, inserted, generateReportMock, resolveLiveMock, preflightMock } = vi.hoisted(() => ({
  rows: [] as unknown[], inserted: [] as unknown[],
  generateReportMock: vi.fn(), resolveLiveMock: vi.fn(), preflightMock: vi.fn(),
}));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select','from','where','limit','orderBy','update','set','insert','returning']) chain[m] = vi.fn(() => chain);
  chain.values = vi.fn((v: unknown) => { inserted.push(v); return chain; });
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(rows.shift() ?? []).then(r);
  return { db: chain, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() };
});
vi.mock('./reportGenerationService', () => ({ generateReport: generateReportMock, assertReportExecutionPreflight: preflightMock }));
vi.mock('./siteScope', async (orig) => ({ ...(await orig<typeof import('./siteScope')>()), resolveLiveReportAuthority: resolveLiveMock }));
import { generateAutoEvidenceForOccurrence } from './deliverableAutoEvidence';

const DEF = { id: 'r1', orgId: 'org1', type: 'vulnerability_summary', config: {}, name: 'Vulnerability summary',
  executionScopePrincipalKind: 'user', executionScopeUserId: 'u1',
  executionScopeVersion: 1, executionScopeKind: 'unrestricted', executionScopeSiteIds: null };
const ARGS = { orgId: 'org1', occurrenceId: 'o1', ticketId: 't1', reportId: 'r1', dueAt: '2026-10-31', today: '2026-10-31' };
const LIVE = { ok: true, authority: { principalKind: 'user', principalUserId: 'u1', capturedAt: new Date(),
  fingerprint: 'f', scope: { version: 1, kind: 'unrestricted', orgId: 'org1' } } };

describe('generateAutoEvidenceForOccurrence (spec D12)', () => {
  beforeEach(() => { rows.length = 0; inserted.length = 0; vi.clearAllMocks(); });

  it('does nothing before the due date', async () => {
    expect(await generateAutoEvidenceForOccurrence({ ...ARGS, today: '2026-10-30' })).toEqual({ ok: false, reason: 'not_due' });
    expect(generateReportMock).not.toHaveBeenCalled();
  });

  it('never generates twice for the same occurrence', async () => {
    rows.push([{ id: 'e1' }]);
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: false, reason: 'already_attached' });
    expect(generateReportMock).not.toHaveBeenCalled();
  });

  it('stamps the run requested_by_kind=system with BOTH requester ids null, attaches evidence and a note', async () => {
    rows.push([], [DEF]);
    resolveLiveMock.mockResolvedValue(LIVE);
    rows.push([{ id: 'run1' }]);
    generateReportMock.mockResolvedValue({ rows: [{ a: 1 }], rowCount: 1, summary: {} });
    rows.push([], [{ id: 'e1' }], []);
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: true, reportRunId: 'run1' });
    expect(inserted[0]).toMatchObject({ reportId: 'r1', status: 'running', requestedByKind: 'system', requestedByUserId: null, requestedByPortalUserId: null });
    expect(inserted[1]).toMatchObject({ orgId: 'org1', occurrenceId: 'o1', kind: 'report_run', reportId: 'r1', reportRunId: 'run1' });
    expect(inserted[2]).toMatchObject({ ticketId: 't1', commentType: 'internal', isPublic: false, content: 'Report attached, review and resolve' });
  });

  it('refuses a system-principal definition instead of inventing a principal', async () => {
    rows.push([], [{ ...DEF, executionScopePrincipalKind: 'system', executionScopeUserId: null }]);
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: false, reason: 'system_principal_definition' });
    expect(generateReportMock).not.toHaveBeenCalled();
  });

  it('refuses when the owning user no longer holds the scope', async () => {
    rows.push([], [DEF]);
    resolveLiveMock.mockResolvedValue({ ok: false, reason: 'permission_removed' });
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: false, reason: 'scope_unverifiable' });
  });

  it('records a failed run and attaches no evidence when generation throws', async () => {
    rows.push([], [DEF]);
    resolveLiveMock.mockResolvedValue(LIVE);
    rows.push([{ id: 'run1' }]);
    generateReportMock.mockRejectedValue(new Error('boom'));
    rows.push([]);
    expect(await generateAutoEvidenceForOccurrence(ARGS)).toEqual({ ok: false, reason: 'generation_failed' });
    expect(inserted).toHaveLength(1);                       // only the run row
  });

  it('attaches evidence but posts no comment when the occurrence has no ticket', async () => {
    rows.push([], [DEF]);
    resolveLiveMock.mockResolvedValue(LIVE);
    rows.push([{ id: 'run1' }]);
    generateReportMock.mockResolvedValue({ rows: [], rowCount: 0 });
    rows.push([], [{ id: 'e1' }]);
    expect(await generateAutoEvidenceForOccurrence({ ...ARGS, ticketId: null })).toEqual({ ok: true, reportRunId: 'run1' });
    expect(inserted).toHaveLength(2);                       // run + evidence, no comment
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/deliverableAutoEvidence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Auto-evidence for service deliverables (spec D12, §5.3 step 3).
 *
 * A deliverable with `auto_evidence_report_id` gets a run of that report on its
 * due date, attached as `report_run` evidence, plus an internal ticket note. The
 * technician reviews a report Breeze already made instead of assembling one.
 *
 * AUTHORITY: ReportExecutionAuthority has no 'system' arm by design
 * (siteScope.ts:84-96 — widening it would let user-path callers forge human
 * provenance). So this reproduces reportScheduleWorker.ts's reauthorization
 * sequence: refuse a non-user-principal definition, decode its persisted scope,
 * re-resolve the owner's LIVE scope, intersect. `requested_by_kind` is still
 * 'system' — the sweep asked for the run, not the owner.
 */
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { reports, reportRuns } from '../db/schema/reports';
import { serviceDeliverableEvidence, serviceDeliverableOccurrences } from '../db/schema/serviceDeliverables';
import { ticketComments } from '../db/schema/portal';
import { generateReport, assertReportExecutionPreflight } from './reportGenerationService';
import {
  decodeSiteScope, intersectSiteScopes, persistedSiteScopeValues, resolveLiveReportAuthority,
  siteScopeFingerprint, type PersistedSiteScopeColumns, type ReportExecutionAuthority,
} from './siteScope';
import type { SweepDeliverable } from './serviceDeliverableService';

export const AUTO_EVIDENCE_TICKET_NOTE = 'Report attached, review and resolve';

export type AutoEvidenceOutcome =
  | { ok: true; reportRunId: string }
  | { ok: false; reason: 'already_attached' | 'not_due' | 'definition_not_found'
      | 'system_principal_definition' | 'portal_user_principal_definition'
      | 'scope_unverifiable' | 'scope_no_intersection' | 'scope_empty' | 'generation_failed' };

const failed = (reason: Exclude<AutoEvidenceOutcome, { ok: true }>['reason']): AutoEvidenceOutcome => ({ ok: false, reason });

/** Every `open` occurrence of this deliverable that is due and has no run yet. */
export async function generateAutoEvidenceForDeliverable(d: SweepDeliverable, today: string): Promise<number> {
  if (!d.autoEvidenceReportId) return 0;
  const open = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({ id: serviceDeliverableOccurrences.id, ticketId: serviceDeliverableOccurrences.ticketId,
                dueAt: serviceDeliverableOccurrences.dueAt })
      .from(serviceDeliverableOccurrences)
      .where(and(eq(serviceDeliverableOccurrences.deliverableId, d.id), eq(serviceDeliverableOccurrences.status, 'open'))),
    'deliverableSweep.selectAutoEvidence'));

  let generated = 0;
  for (const occ of open) {
    const res = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      generateAutoEvidenceForOccurrence({
        orgId: d.orgId, occurrenceId: occ.id, ticketId: occ.ticketId,
        reportId: d.autoEvidenceReportId!, dueAt: occ.dueAt, today,
      }), 'deliverableSweep.autoEvidence'));
    if (res.ok) generated++;
    else if (res.reason !== 'not_due' && res.reason !== 'already_attached') {
      // Never silent: a refused or failed generation leaves the occurrence
      // untouched and the technician delivers manually.
      console.warn('[deliverables] auto-evidence skipped', `occurrenceId=${occ.id}`, `reportId=${d.autoEvidenceReportId}`, `reason=${res.reason}`);
    }
  }
  return generated;
}

export async function generateAutoEvidenceForOccurrence(args: {
  orgId: string; occurrenceId: string; ticketId: string | null; reportId: string; dueAt: string; today: string;
}): Promise<AutoEvidenceOutcome> {
  if (args.today < args.dueAt) return failed('not_due');

  // Once per occurrence, ever (spec §5.3 step 3).
  const existing = await db.select({ id: serviceDeliverableEvidence.id })
    .from(serviceDeliverableEvidence)
    .where(and(eq(serviceDeliverableEvidence.occurrenceId, args.occurrenceId), eq(serviceDeliverableEvidence.kind, 'report_run')))
    .limit(1);
  if (existing.length > 0) return failed('already_attached');

  const [definition] = await db.select().from(reports)
    .where(and(eq(reports.id, args.reportId), eq(reports.orgId, args.orgId))).limit(1);
  if (!definition) return failed('definition_not_found');

  const principal = definition.executionScopePrincipalKind ?? null;
  if (principal === 'system') return failed('system_principal_definition');
  if (principal === 'portal_user') return failed('portal_user_principal_definition');
  if (!definition.executionScopeUserId) return failed('scope_unverifiable');

  let persistedScope;
  try { persistedScope = decodeSiteScope(definition as unknown as PersistedSiteScopeColumns, definition.orgId); }
  catch { return failed('scope_unverifiable'); }
  if (persistedScope.kind === 'legacy_unscoped') return failed('scope_unverifiable');

  const live = await resolveLiveReportAuthority(definition.executionScopeUserId, definition.orgId, 'read')
    .catch(() => ({ ok: false as const, reason: 'unverifiable_scope' as const }));
  if (!live.ok || live.authority.scope.kind === 'legacy_unscoped') return failed('scope_unverifiable');

  const effectiveScope = intersectSiteScopes(persistedScope, live.authority.scope);
  if (!effectiveScope) return failed('scope_no_intersection');
  if (effectiveScope.kind === 'legacy_unscoped') return failed('scope_unverifiable');
  if (effectiveScope.kind === 'restricted' && effectiveScope.siteIds.length === 0) return failed('scope_empty');

  const authority: ReportExecutionAuthority = {
    principalKind: 'user', scope: effectiveScope,
    principalUserId: live.authority.principalUserId, capturedAt: live.authority.capturedAt,
    fingerprint: siteScopeFingerprint(effectiveScope),
  };
  const config = (definition.config ?? {}) as Record<string, unknown>;
  try { assertReportExecutionPreflight(definition.orgId, config, authority, definition.type); }
  catch { return failed('scope_unverifiable'); }

  const [run] = await db.insert(reportRuns).values({
      reportId: definition.id, status: 'running', startedAt: new Date(),
      // The sweep requested this run; no human did. report_runs_requested_by_shape_chk
      // requires BOTH ids NULL for 'system'.
      requestedByKind: 'system', requestedByUserId: null, requestedByPortalUserId: null,
      ...persistedSiteScopeValues(authority),
    }).returning({ id: reportRuns.id });
  if (!run) return failed('generation_failed');

  let result;
  try {
    result = await generateReport(definition.type, definition.orgId, config, authority);
  } catch (err) {
    await db.update(reportRuns).set({ status: 'failed', completedAt: new Date(),
      errorMessage: err instanceof Error ? err.message : 'Failed to generate report' })
      .where(eq(reportRuns.id, run.id));
    return failed('generation_failed');
  }

  const rowsOut = Array.isArray(result.rows) ? result.rows : [];
  await db.update(reportRuns).set({
      status: 'completed', completedAt: new Date(),
      outputUrl: `/api/reports/runs/${run.id}/download`,
      result, rowCount: result.rowCount ?? rowsOut.length,
    }).where(eq(reportRuns.id, run.id));

  await db.insert(serviceDeliverableEvidence).values({
      orgId: args.orgId, occurrenceId: args.occurrenceId, kind: 'report_run',
      // report_id proves org ownership: report_runs has no org_id of its own
      // (D6), so the composite FK (report_id, org_id) -> reports(id, org_id) is
      // what keeps a foreign run out.
      reportId: definition.id, reportRunId: run.id, createdByUserId: null,
    }).returning({ id: serviceDeliverableEvidence.id });

  if (args.ticketId) {
    await db.insert(ticketComments).values({
      ticketId: args.ticketId, userId: null, authorName: 'Breeze', authorType: 'system',
      commentType: 'internal', content: AUTO_EVIDENCE_TICKET_NOTE, isPublic: false,
    });
  }
  return { ok: true, reportRunId: run.id };
}
```

Before finishing, confirm the exact export names `intersectSiteScopes`, `siteScopeFingerprint`, `PersistedSiteScopeColumns` in `services/siteScope.ts` (used verbatim by `reportScheduleWorker.ts:603, 625, 568`) and `assertReportExecutionPreflight`'s fourth parameter (`reportType?: ReportType`, `reportGenerationService.ts:232`).

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/deliverableAutoEvidence.test.ts && npx tsc --noEmit`
Expected: PASS (7 tests); no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/deliverableAutoEvidence.ts apps/api/src/services/deliverableAutoEvidence.test.ts
git commit -m "feat(deliverables): auto-evidence report runs attached to due occurrences (W02)"
```

---

### Task 5: Key-date reminders and annual roll-forward

**Files:**
- Modify: `apps/api/src/services/orgKeyDateService.ts`; Test: `apps/api/src/services/orgKeyDateService.test.ts` (append)

**Interfaces:**
- Produces: `export function sweepKeyDateReminders(today: string): Promise<number>;` and `export function rollForwardAnnualKeyDates(today: string): Promise<number>;`

- [ ] **Step 1: Write the failing tests**

```ts
const K = { id: 'k1', orgId: 'org1', label: 'Cyber insurance renewal', kind: 'insurance_renewal',
  date: '2027-03-01', ownerUserId: 'u1' };

describe('sweepKeyDateReminders (spec §5.3 step 5)', () => {
  beforeEach(() => { dbMocks.rows.length = 0; dbMocks.updated.length = 0; createTicketMock.mockReset(); });

  it('creates one deliverable-kind reminder ticket and stamps reminded_for_date', async () => {
    dbMocks.rows.push([K], [{ id: 'k1' }], [], []);          // due, claim, link, roll-forward
    createTicketMock.mockResolvedValue({ id: 't9' });
    expect(await sweepKeyDateReminders('2027-01-01')).toBe(1);
    expect(createTicketMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org1', source: 'api', workKind: 'deliverable',
      subject: 'Key date: Cyber insurance renewal — 2027-03-01',
      dueDate: new Date('2027-03-01T00:00:00.000Z'), assigneeId: 'u1',
    }), expect.anything());
    expect(dbMocks.updated.some((u) => (u as Record<string, unknown>).remindedForDate === '2027-03-01')).toBe(true);
  });

  it('never reminds twice for the same (id, date)', async () => {
    dbMocks.rows.push([K], [], []);                          // claim matched 0 rows
    expect(await sweepKeyDateReminders('2027-01-01')).toBe(0);
    expect(createTicketMock).not.toHaveBeenCalled();
  });

  it('still stamps the reminder when Service Management is off', async () => {
    dbMocks.rows.push([K], [{ id: 'k1' }], []);
    createTicketMock.mockRejectedValue(Object.assign(new Error('off'), { code: 'service_management_off' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { expect(await sweepKeyDateReminders('2027-01-01')).toBe(1); } finally { warn.mockRestore(); }
  });
});

describe('rollForwardAnnualKeyDates', () => {
  beforeEach(() => { dbMocks.rows.length = 0; dbMocks.updated.length = 0; });

  it('advances a past recurring date one year and clears both reminder stamps', async () => {
    dbMocks.rows.push([{ id: 'k1', date: '2026-03-01' }], [{ id: 'k1' }]);
    expect(await rollForwardAnnualKeyDates('2026-09-10')).toBe(1);
    expect(dbMocks.updated.at(-1)).toMatchObject({ date: '2027-03-01', remindedForDate: null, reminderTicketId: null });
  });

  it('leaves a future date alone', async () => {
    dbMocks.rows.push([]);
    expect(await rollForwardAnnualKeyDates('2026-09-10')).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/orgKeyDateService.test.ts`
Expected: FAIL — `sweepKeyDateReminders` is not exported.

- [ ] **Step 3: Implement**

```ts
const KEY_DATE_SWEEP_ACTOR = { userId: '00000000-0000-0000-0000-000000000000', name: 'Key dates' } as const;

/**
 * Spec §5.3 step 5. Two passes:
 *  1. reminders — `date - remind_days_before <= today` and `reminded_for_date IS
 *     DISTINCT FROM date`. The stamp IS the claim: written by a CAS UPDATE
 *     before the ticket is created, so a crash mid-create loses the ticket,
 *     never doubles it.
 *  2. annual roll-forward — a recurring date in the past advances one year and
 *     drops its reminder stamps so next year's reminder can fire at all.
 */
export async function sweepKeyDateReminders(today: string): Promise<number> {
  const due = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({ id: organizationKeyDates.id, orgId: organizationKeyDates.orgId,
                label: organizationKeyDates.label, kind: organizationKeyDates.kind,
                date: organizationKeyDates.date, ownerUserId: organizationKeyDates.ownerUserId })
      .from(organizationKeyDates)
      .where(and(
        isNotNull(organizationKeyDates.remindDaysBefore),
        sql`${organizationKeyDates.date} - (${organizationKeyDates.remindDaysBefore} * INTERVAL '1 day') <= ${today}::date`,
        sql`${organizationKeyDates.remindedForDate} IS DISTINCT FROM ${organizationKeyDates.date}`,
        buildAutomationEligibleOrgPredicate(organizationKeyDates.orgId)
      )), 'keyDateSweep.selectDue'));

  let created = 0;
  for (const row of due) {
    created += await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const claimed = await db.update(organizationKeyDates)
        .set({ remindedForDate: row.date, updatedAt: new Date() })
        .where(and(eq(organizationKeyDates.id, row.id),
          sql`${organizationKeyDates.remindedForDate} IS DISTINCT FROM ${row.date}::date`))
        .returning({ id: organizationKeyDates.id });
      if (claimed.length === 0) return 0;

      let ticketId: string | null = null;
      try {
        const ticket = await createTicket({
          orgId: row.orgId, source: 'api', workKind: 'deliverable',
          subject: `Key date: ${row.label} — ${row.date}`,
          description: `This ${String(row.kind).replace(/_/g, ' ')} key date falls on ${row.date}.`,
          dueDate: new Date(`${row.date}T00:00:00.000Z`),
          assigneeId: row.ownerUserId ?? undefined,
        }, KEY_DATE_SWEEP_ACTOR);
        ticketId = ticket.id;
      } catch (err) {
        if ((err as { code?: string }).code !== 'service_management_off') throw err;
        console.warn('[deliverables] key-date reminder without a ticket (Service Management off)', `orgId=${row.orgId}`, `keyDateId=${row.id}`);
        return 1;
      }
      await db.update(organizationKeyDates)
        .set({ reminderTicketId: ticketId, updatedAt: new Date() })
        .where(eq(organizationKeyDates.id, row.id));
      return 1;
    }, 'keyDateSweep.remind'));
  }

  await rollForwardAnnualKeyDates(today);
  return created;
}

export async function rollForwardAnnualKeyDates(today: string): Promise<number> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const stale = await db.select({ id: organizationKeyDates.id, date: organizationKeyDates.date })
      .from(organizationKeyDates)
      .where(and(eq(organizationKeyDates.recursAnnually, true), lt(organizationKeyDates.date, today)));
    let rolled = 0;
    for (const row of stale) {
      const updated = await db.update(organizationKeyDates)
        .set({ date: addMonthsClamped(row.date, 12), remindedForDate: null, reminderTicketId: null, updatedAt: new Date() })
        .where(and(eq(organizationKeyDates.id, row.id), eq(organizationKeyDates.date, row.date)))
        .returning({ id: organizationKeyDates.id });
      rolled += updated.length;
    }
    return rolled;
  }, 'keyDateSweep.rollForward'));
}
```

Add `isNotNull`, `lt`, `sql` to the drizzle import; `createTicket` from `./ticketService`; `buildAutomationEligibleOrgPredicate` from `./tenantStatus`; `addMonthsClamped` from `./contractMath`; `runOutsideDbContext`, `withSystemDbAccessContext` from `../db`.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/orgKeyDateService.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/orgKeyDateService.ts apps/api/src/services/orgKeyDateService.test.ts
git commit -m "feat(deliverables): key-date reminder tickets and annual roll-forward (W02)"
```

---

### Task 6: `applyTicketStatusChange` and the `deliverable-status` subscriber

**Files:**
- Modify: `apps/api/src/services/serviceDeliverableService.ts` (replace the `applyTicketStatusChange` stub)
- Create: `apps/api/src/services/deliverableStatusSubscriber.ts` (+ `.test.ts`)
- Modify: `apps/api/src/services/eventSubscriberIds.ts:4-19`; `apps/api/src/services/eventSubscribers.ts:135`

**Interfaces:**
- Consumes: `transition` (`services/serviceDeliverableState.ts`, W01 Task 6); `BreezeEvent` (`services/eventBus.ts:197`).
- Produces: `applyTicketStatusChange` (W01 signature, unchanged) and `export function handleDeliverableTicketStatusChanged(event: BreezeEvent): Promise<void>;`

**Payload facts the implementer must not guess.** `ticket.status_changed` is published from the transactional outbox with an **id-only** payload `{ ticketId, from, to }` (`ticketService.ts:1037` writes `{ from, to }`; `jobs/ticketOutboxPublisher.ts:199` prepends `ticketId`). It carries **no** actor and **no** resolution note — both are content, deliberately excluded. The subscriber re-reads both under a system context. The actor is recoverable exactly: `changeTicketStatus` inserts a `ticket_comments` row with `commentType='status_change'`, `oldValue=fromStatus`, `newValue=toStatus`, `userId=actor.userId` (`ticketService.ts:1018-1029`).

- [ ] **Step 1: Write the failing tests**

`deliverableStatusSubscriber.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows, applyMock } = vi.hoisted(() => ({ rows: [] as unknown[], applyMock: vi.fn() }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select','from','where','limit','orderBy']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(rows.shift() ?? []).then(r);
  return { db: chain, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() };
});
vi.mock('./serviceDeliverableService', () => ({ applyTicketStatusChange: applyMock }));
import { handleDeliverableTicketStatusChanged } from './deliverableStatusSubscriber';

const evt = (payload: unknown) => ({ id: 'e1', type: 'ticket.status_changed', orgId: 'org1',
  source: 't', priority: 'normal', payload, metadata: { timestamp: '' } } as never);

describe('deliverable-status subscriber (spec §6)', () => {
  beforeEach(() => { rows.length = 0; vi.clearAllMocks(); });

  it('drops a malformed event without touching the service', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await handleDeliverableTicketStatusChanged(evt({ to: 'resolved' }));
      expect(applyMock).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalled();
    } finally { err.mockRestore(); }
  });

  it('ignores a ticket no occurrence is linked to', async () => {
    rows.push([]);
    await handleDeliverableTicketStatusChanged(evt({ ticketId: 't1', from: 'open', to: 'resolved' }));
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('passes the resolution note and the status-change actor through on resolve', async () => {
    rows.push([{ id: 'o1' }], [{ resolutionNote: 'Reviewed, no findings' }], [{ userId: 'u7' }]);
    await handleDeliverableTicketStatusChanged(evt({ ticketId: 't1', from: 'open', to: 'resolved' }));
    expect(applyMock).toHaveBeenCalledWith({ ticketId: 't1', orgId: 'org1', to: 'resolved', actorUserId: 'u7', resolutionNote: 'Reviewed, no findings' });
  });

  it('forwards a reopen with a null note', async () => {
    rows.push([{ id: 'o1' }], [{ resolutionNote: null }], []);
    await handleDeliverableTicketStatusChanged(evt({ ticketId: 't1', from: 'resolved', to: 'open' }));
    expect(applyMock).toHaveBeenCalledWith({ ticketId: 't1', orgId: 'org1', to: 'open', actorUserId: null, resolutionNote: null });
  });
});
```

Append to `serviceDeliverableService.test.ts`:

```ts
const occRow = (over: Record<string, unknown> = {}) => ({ id: 'o1', orgId: 'org1', status: 'open',
  deliveredVia: null, artifactRequired: true, completionMode: 'on_ticket_resolve', ...over });

describe('applyTicketStatusChange (spec §6)', () => {
  beforeEach(() => { dbMocks.rows.length = 0; dbMocks.updated.length = 0; });

  it('resolve with evidence delivers via ticket and copies the resolution note', async () => {
    dbMocks.rows.push([occRow()], [{ id: 'e1' }], [{ id: 'o1' }]);
    await applyTicketStatusChange({ ticketId: 't1', orgId: 'org1', to: 'resolved', actorUserId: 'u7', resolutionNote: 'done' });
    expect(dbMocks.updated.at(-1)).toMatchObject({ status: 'delivered', deliveredVia: 'ticket', deliveredByUserId: 'u7', deliveryNote: 'done' });
  });

  it('resolve with artifact required and no evidence goes to awaiting_evidence, stamping no delivery', async () => {
    dbMocks.rows.push([occRow()], [], [{ id: 'o1' }]);
    await applyTicketStatusChange({ ticketId: 't1', orgId: 'org1', to: 'closed', actorUserId: null, resolutionNote: null });
    const patch = dbMocks.updated.at(-1) as Record<string, unknown>;
    expect(patch).toMatchObject({ status: 'awaiting_evidence' });
    expect(patch.deliveredAt).toBeUndefined();
  });

  it('explicit completion mode changes nothing', async () => {
    dbMocks.rows.push([occRow({ completionMode: 'explicit' })], []);
    await applyTicketStatusChange({ ticketId: 't1', orgId: 'org1', to: 'resolved', actorUserId: 'u7', resolutionNote: 'x' });
    expect(dbMocks.updated).toHaveLength(0);
  });

  it('a reopen undoes a ticket-driven delivery and clears the delivery fields', async () => {
    dbMocks.rows.push([occRow({ status: 'delivered', deliveredVia: 'ticket' })], [], [{ id: 'o1' }]);
    await applyTicketStatusChange({ ticketId: 't1', orgId: 'org1', to: 'open', actorUserId: 'u7', resolutionNote: null });
    expect(dbMocks.updated.at(-1)).toMatchObject({ status: 'open', deliveredAt: null, deliveredByUserId: null, deliveredVia: null, deliveryNote: null });
  });

  it('a reopen NEVER undoes an explicit delivery', async () => {
    dbMocks.rows.push([occRow({ status: 'delivered', deliveredVia: 'explicit' })], []);
    await applyTicketStatusChange({ ticketId: 't1', orgId: 'org1', to: 'open', actorUserId: 'u7', resolutionNote: null });
    expect(dbMocks.updated).toHaveLength(0);
  });

  it('is idempotent — a redelivery of an already-delivered occurrence is a no-op', async () => {
    dbMocks.rows.push([occRow({ status: 'delivered', deliveredVia: 'ticket' })], [{ id: 'e1' }]);
    await applyTicketStatusChange({ ticketId: 't1', orgId: 'org1', to: 'resolved', actorUserId: 'u7', resolutionNote: 'done' });
    expect(dbMocks.updated).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/deliverableStatusSubscriber.test.ts src/services/serviceDeliverableService.test.ts`
Expected: FAIL — module not found, and `not implemented (W02)`.

- [ ] **Step 3: Implement the service function**

```ts
const RESOLVED_LIKE = new Set(['resolved', 'closed']);
const REOPENED_LIKE = new Set(['new', 'open', 'pending', 'on_hold']);

/**
 * Spec §6. Advisory, not the record of delivery (D4) — the completion policy
 * decides. Idempotent by construction: the write is CAS'd on the status this
 * function read, so a duplicate event updates 0 rows.
 */
export async function applyTicketStatusChange(args: {
  ticketId: string; orgId: string; to: string; actorUserId: string | null; resolutionNote: string | null;
}): Promise<void> {
  const [occ] = await db.select({
      id: serviceDeliverableOccurrences.id, status: serviceDeliverableOccurrences.status,
      deliveredVia: serviceDeliverableOccurrences.deliveredVia,
      artifactRequired: serviceDeliverables.artifactRequired,
      completionMode: serviceDeliverables.completionMode,
    })
    .from(serviceDeliverableOccurrences)
    .innerJoin(serviceDeliverables, eq(serviceDeliverables.id, serviceDeliverableOccurrences.deliverableId))
    .where(and(eq(serviceDeliverableOccurrences.ticketId, args.ticketId), eq(serviceDeliverableOccurrences.orgId, args.orgId)))
    .limit(1);
  if (!occ) return;

  const current = occ.status as OccurrenceStatus;
  let outcome;
  if (RESOLVED_LIKE.has(args.to)) {
    const evidence = await db.select({ id: serviceDeliverableEvidence.id })
      .from(serviceDeliverableEvidence)
      .where(eq(serviceDeliverableEvidence.occurrenceId, occ.id)).limit(1);
    outcome = transition(current, {
      type: 'ticket_resolved', hasEvidence: evidence.length > 0,
      artifactRequired: occ.artifactRequired,
      completionMode: occ.completionMode as 'explicit' | 'on_ticket_resolve',
    });
  } else if (REOPENED_LIKE.has(args.to)) {
    outcome = transition(current, { type: 'ticket_reopened', deliveredVia: occ.deliveredVia });
  } else {
    return;
  }
  if (outcome.next === null) return;

  const patch: Record<string, unknown> = { status: outcome.next, updatedAt: new Date() };
  if (outcome.next === 'delivered') {
    patch.deliveredAt = new Date();
    patch.deliveredByUserId = args.actorUserId;
    patch.deliveredVia = 'ticket';
    patch.deliveryNote = args.resolutionNote;
  } else if (outcome.next === 'open') {
    patch.deliveredAt = null; patch.deliveredByUserId = null;
    patch.deliveredVia = null; patch.deliveryNote = null;
  }

  await db.update(serviceDeliverableOccurrences).set(patch)
    // CAS on the status we decided from: a concurrent write loses silently.
    .where(and(eq(serviceDeliverableOccurrences.id, occ.id), eq(serviceDeliverableOccurrences.status, current)));
}
```

- [ ] **Step 4: Implement the subscriber**

```ts
/**
 * `ticket.status_changed` -> service-deliverable occurrence (spec §6).
 *
 * The payload is id-only by design (`{ ticketId, from, to }` —
 * ticketService.ts:1037 + ticketOutboxPublisher.ts:199), so neither the acting
 * user nor the resolution note travels on it. Both are re-read here under a
 * system context: the note from `tickets.resolution_note`, the actor from the
 * `status_change` comment changeTicketStatus writes with the real actor id
 * (ticketService.ts:1018-1029). No linked occurrence means this handler does
 * nothing at all — the overwhelming majority of tickets.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { tickets, ticketComments } from '../db/schema/portal';
import { serviceDeliverableOccurrences } from '../db/schema/serviceDeliverables';
import { applyTicketStatusChange } from './serviceDeliverableService';
import type { BreezeEvent } from './eventBus';

export async function handleDeliverableTicketStatusChanged(event: BreezeEvent): Promise<void> {
  const payload = event.payload as { ticketId?: unknown; to?: unknown } | null | undefined;
  const ticketId = typeof payload?.ticketId === 'string' ? payload.ticketId : null;
  const to = typeof payload?.to === 'string' ? payload.to : null;
  const orgId = event.orgId;
  if (!ticketId || !to || !orgId) {
    console.error('[deliverableStatusSubscriber] malformed ticket.status_changed — dropping',
      { eventId: event.id, orgId, payload: event.payload });
    return;
  }

  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const linked = await db.select({ id: serviceDeliverableOccurrences.id })
      .from(serviceDeliverableOccurrences)
      .where(and(eq(serviceDeliverableOccurrences.ticketId, ticketId), eq(serviceDeliverableOccurrences.orgId, orgId)))
      .limit(1);
    if (linked.length === 0) return;

    const [ticket] = await db.select({ resolutionNote: tickets.resolutionNote })
      .from(tickets).where(eq(tickets.id, ticketId)).limit(1);

    const [statusComment] = await db.select({ userId: ticketComments.userId })
      .from(ticketComments)
      .where(and(eq(ticketComments.ticketId, ticketId),
        eq(ticketComments.commentType, 'status_change'), eq(ticketComments.newValue, to)))
      .orderBy(desc(ticketComments.createdAt)).limit(1);

    await applyTicketStatusChange({
      ticketId, orgId, to,
      actorUserId: statusComment?.userId ?? null,
      resolutionNote: ticket?.resolutionNote ?? null,
    });
  }, 'deliverableStatusSubscriber'));
}
```

- [ ] **Step 5: Register the subscriber**

`eventSubscriberIds.ts` — insert alphabetically between `'automation-worker'` and `'dns-threat-alerts'`:

```ts
  // Service deliverables W02 (spec §6) — turns a real ticket resolution into a
  // delivery record per the deliverable's completion policy.
  'deliverable-status',
```

`eventSubscribers.ts`, after the `ai-agent-ticket-helpdesk` block (line 135):

```ts
  registerEventSubscriber({
    id: 'deliverable-status',
    // Lazy import for the same reason as every ticket subscriber above:
    // workerEntrypointClosure.contract.test.ts constrains what this module may
    // pull into the worker boot closure statically.
    eventTypes: ['ticket.status_changed'],
    handler: async (event: BreezeEvent) => {
      const { handleDeliverableTicketStatusChanged } = await import('./deliverableStatusSubscriber');
      return handleDeliverableTicketStatusChanged(event);
    },
    retry: { attempts: 5, backoffMs: 10_000 },
  });
```

- [ ] **Step 6: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/deliverableStatusSubscriber.test.ts src/services/serviceDeliverableService.test.ts src/services/eventSubscribers.contract.test.ts src/services/workerEntrypointClosure.contract.test.ts && npx tsc --noEmit`
Expected: PASS. `eventSubscribers.contract.test.ts` fails if the id is registered zero or twice, or registered without being in `EVENT_SUBSCRIBER_IDS`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/serviceDeliverableService.ts apps/api/src/services/serviceDeliverableService.test.ts apps/api/src/services/deliverableStatusSubscriber.ts apps/api/src/services/deliverableStatusSubscriber.test.ts apps/api/src/services/eventSubscriberIds.ts apps/api/src/services/eventSubscribers.ts
git commit -m "feat(deliverables): ticket.status_changed subscriber records delivery (W02)"
```

---

### Task 7: Contract-cancelled hook

**Files:**
- Modify: `apps/api/src/services/serviceDeliverableService.ts`; Test: `serviceDeliverableService.test.ts` (append)

**Interfaces:**
- Produces: `export function applyContractCancelledToDeliverables(contractId: string, today: string): Promise<number>;`

- [ ] **Step 1: Write the failing tests**

```ts
describe('applyContractCancelledToDeliverables (spec §5.4)', () => {
  beforeEach(() => { dbMocks.rows.length = 0; dbMocks.updated.length = 0; });

  it('closes the effective window of every open-ended deliverable on the contract', async () => {
    dbMocks.rows.push([{ id: 'c1', status: 'cancelled' }], [{ id: 'd1' }, { id: 'd2' }]);
    expect(await applyContractCancelledToDeliverables('c1', '2026-09-10')).toBe(2);
    expect(dbMocks.updated.at(-1)).toMatchObject({ effectiveUntil: '2026-09-10' });
  });

  it('does nothing when the contract is no longer cancelled (a replayed event)', async () => {
    dbMocks.rows.push([{ id: 'c1', status: 'active' }]);
    expect(await applyContractCancelledToDeliverables('c1', '2026-09-10')).toBe(0);
    expect(dbMocks.updated).toHaveLength(0);
  });

  it('does nothing for a contract that no longer exists', async () => {
    dbMocks.rows.push([]);
    expect(await applyContractCancelledToDeliverables('gone', '2026-09-10')).toBe(0);
  });

  it('never overwrites an effective_until the MSP already set', async () => {
    dbMocks.rows.push([{ id: 'c1', status: 'cancelled' }], []);   // IS NULL predicate matched nothing
    expect(await applyContractCancelledToDeliverables('c1', '2026-09-10')).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/serviceDeliverableService.test.ts`
Expected: FAIL — `applyContractCancelledToDeliverables` is not exported.

- [ ] **Step 3: Implement**

```ts
/**
 * Spec §5.4. A cancelled contract ends the service it paid for, so every
 * deliverable still open-ended on it stops today. `paused` deliberately does
 * nothing (a billing pause is not a service pause) and `expired` is ignored
 * entirely (D1 — generateDueInvoice expires an annual-advance contract the day
 * after its single invoice while service runs 12 more months).
 *
 * The contract's CURRENT status is re-read rather than trusted from the event:
 * `contract-events` gained its first consumer in this wave, so the first deploy
 * drains a historical backlog, and a cancel later reversed must not close a
 * live deliverable. `cancelContract` (contractService.ts:1690-1698) stores no
 * cancellation timestamp, so `today` is the processing date, not a back-date.
 */
export async function applyContractCancelledToDeliverables(contractId: string, today: string): Promise<number> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [contract] = await db.select({ id: contracts.id, status: contracts.status })
      .from(contracts).where(eq(contracts.id, contractId)).limit(1);
    if (!contract || contract.status !== 'cancelled') return 0;

    const updated = await db.update(serviceDeliverables)
      .set({ effectiveUntil: today, updatedAt: new Date() })
      .where(and(eq(serviceDeliverables.contractId, contractId), isNull(serviceDeliverables.effectiveUntil)))
      .returning({ id: serviceDeliverables.id });
    if (updated.length > 0) {
      console.log('[deliverables] contract cancelled — closed effective window',
        `contractId=${contractId}`, `deliverables=${updated.length}`, `effectiveUntil=${today}`);
    }
    return updated.length;
  }, 'deliverables.contractCancelled'));
}
```

Add `isNull` to the drizzle import and `contracts` from `../db/schema/contracts` if not already imported.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/serviceDeliverableService.test.ts src/jobs/deliverableWorker.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/serviceDeliverableService.ts apps/api/src/services/serviceDeliverableService.test.ts
git commit -m "feat(deliverables): contract-cancelled hook closes the effective window (W02)"
```

---

### Task 8: Move-org guard — 409 `DELIVERABLE_TICKET_PINNED`

**Files:**
- Modify: `apps/api/src/services/ticketService.ts` — `TicketServiceErrorCode` union (~45-62), `moveTicketOrg` (insert after the partner check at line 2339)
- Test: `apps/api/src/services/ticketService.moveOrg.deliverable.test.ts`

**Where the guard goes, and why the service, not the route.** `routes/tickets/moveOrg.ts` is one of two doors — the `manage_tickets` AI tool calls `moveTicketOrg` directly (`services/aiToolsTicketing.ts:754-756`). Both funnel through `moveTicketOrg` (`ticketService.ts:2260`), where every other tenancy guard already lives (`:2336`, `:2337-2339`, `:2515`). The database is the real backstop: `sd_occ_ticket_org_fk` is `FOREIGN KEY (ticket_id, org_id) REFERENCES tickets(id, org_id)` with the default `ON UPDATE NO ACTION`, so re-stamping `tickets.org_id` under a linked occurrence raises `23503` regardless. The app guard turns that into a 409 the UI can explain. `service_deliverable_occurrences` is therefore **deliberately absent** from `TICKET_ORG_DENORMALIZED_TABLES` (`services/ticketOrgMoveLockOrder.ts:117-124`): a pinned ticket never moves, so there is nothing to re-stamp. Do not add it there.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { DELIVERABLE_TICKET_PINNED_MESSAGE, assertTicketNotPinnedToDeliverable } from './ticketService';

const txWith = (result: unknown[]) => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => result }) }) }) });

describe('move-org deliverable pin (spec §6)', () => {
  it('throws 409 DELIVERABLE_TICKET_PINNED when an occurrence is linked', async () => {
    await expect(assertTicketNotPinnedToDeliverable(txWith([{ id: 'o1', nameSnapshot: 'Sign-in log review' }]) as never, 't1'))
      .rejects.toMatchObject({ status: 409, code: 'DELIVERABLE_TICKET_PINNED', message: DELIVERABLE_TICKET_PINNED_MESSAGE });
  });

  it('passes when no occurrence is linked', async () => {
    await expect(assertTicketNotPinnedToDeliverable(txWith([]) as never, 't1')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/ticketService.moveOrg.deliverable.test.ts`
Expected: FAIL — `assertTicketNotPinnedToDeliverable` is not exported.

- [ ] **Step 3: Implement**

Add `| 'DELIVERABLE_TICKET_PINNED'` to `TicketServiceErrorCode` (after `'service_management_off'`), then above `moveTicketOrg`:

```ts
export const DELIVERABLE_TICKET_PINNED_MESSAGE =
  'This ticket is the work item for a service deliverable and cannot be moved to another organization. Unlink or reschedule the deliverable occurrence first.';

/**
 * Spec §6. A deliverable occurrence pins its ticket to the deliverable's org.
 * Defence in depth only: sd_occ_ticket_org_fk (ticket_id, org_id) ->
 * tickets(id, org_id) has no ON UPDATE clause, so the move would raise 23503
 * anyway — this turns an opaque FK violation into an explainable 409.
 */
export async function assertTicketNotPinnedToDeliverable(tx: typeof db, ticketId: string): Promise<void> {
  const linked = await tx
    .select({ id: serviceDeliverableOccurrences.id, nameSnapshot: serviceDeliverableOccurrences.nameSnapshot })
    .from(serviceDeliverableOccurrences)
    .where(eq(serviceDeliverableOccurrences.ticketId, ticketId))
    .limit(1);
  if (linked.length > 0) {
    throw new TicketServiceError(DELIVERABLE_TICKET_PINNED_MESSAGE, 409, 'DELIVERABLE_TICKET_PINNED');
  }
}
```

Inside `moveTicketOrg`, immediately after the same-partner check (line 2339) and before the `sourceOrg` const:

```ts
    // Cheap precondition, before the ticket UPDATE burns anything.
    await assertTicketNotPinnedToDeliverable(tx, ticketId);
```

Import `serviceDeliverableOccurrences` from `../db/schema/serviceDeliverables`.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/ticketService.moveOrg.deliverable.test.ts src/services/ticketOrgMoveLockOrder.test.ts src/routes/tickets/moveOrg.test.ts && npx tsc --noEmit`
Expected: PASS. The route needs no change — `handleServiceError` (`routes/tickets/tickets.ts:92-99`) already serializes `TicketServiceError` as `{ error, code }` at `err.status`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.moveOrg.deliverable.test.ts
git commit -m "feat(deliverables): block moving a deliverable ticket between orgs (W02)"
```

---

### Task 9: MCP / AI tools for deliverables and key dates

**Files:**
- Create: `apps/api/src/services/aiToolsDeliverables.ts` (+ `.test.ts`)
- Modify: `apps/api/src/services/aiTools.ts:80` and `:294`; `aiToolSchemas.ts:452` area; `aiAgentSdkTools.ts:287` and `:2547` area; `aiGuardrails.ts:703` area

**A new tool has FOUR registration sites** (documented at `services/aiToolsContracts.registryParity.contract.test.ts:1-21`): the core registry, the zod `toolInputSchemas`, the SDK `tool()` block + `TOOL_TIERS`, and `TOOL_PERMISSIONS`. Missing site 4 fails closed with `Unknown action "<x>" for tool "manage_deliverables"`. All three tools are **tier 2 and NOT approval-gated** — no `TIER3_ACTIONS` entry (spec §10: only `apply_template` is gated, and that is W05; it must not appear here).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { aiTools } from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS, TIER3_ACTIONS } from './aiGuardrails';
import { TOOL_TIERS } from './aiAgentSdkTools';

const NAMES = ['list_deliverables', 'manage_deliverables', 'manage_key_dates'] as const;
const MANAGE_ACTIONS = ['create','update','deactivate','deliver','waive','reopen','reschedule','link_evidence'] as const;

describe('deliverable AI tools', () => {
  it('registers all three at tier 2 with a schema, an SDK tier and permissions (the four-site rule)', () => {
    for (const n of NAMES) {
      expect(aiTools.get(n), `${n} not registered`).toBeDefined();
      expect(aiTools.get(n)!.tier).toBe(2);
      expect(toolInputSchemas[n], `${n} missing zod schema`).toBeDefined();
      expect(TOOL_TIERS[n], `${n} missing SDK tier`).toBe(2);
      expect(TOOL_PERMISSIONS[n], `${n} missing permissions`).toBeDefined();
    }
  });

  it('exposes every manage action and NOT apply_template (that is W05)', () => {
    expect(toolInputSchemas.manage_deliverables.safeParse({ action: 'apply_template' }).success).toBe(false);
    const perms = TOOL_PERMISSIONS.manage_deliverables as Record<string, unknown>;
    for (const a of MANAGE_ACTIONS) expect(perms[a], `no permission for ${a}`).toBeDefined();
    expect(perms.apply_template).toBeUndefined();
  });

  it('is not approval-gated', () => {
    for (const n of NAMES) expect(TIER3_ACTIONS[n]).toBeUndefined();
  });

  it('returns a JSON error string instead of throwing a service error', async () => {
    const auth = { user: { id: 'u1' }, partnerId: 'p1', accessibleOrgIds: ['org1'] } as never;
    const out = await aiTools.get('manage_deliverables')!.handler({ action: 'nope' }, auth);
    expect(JSON.parse(out)).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/aiToolsDeliverables.test.ts`
Expected: FAIL — `aiTools.get('list_deliverables')` is `undefined`.

- [ ] **Step 3: Write `aiToolsDeliverables.ts`**

Follow `aiToolsContracts.ts` exactly: raw JSON Schema in `definition.input_schema`, a per-action presence table, `actorFromAuth`, and error-to-JSON conversion instead of throwing.

```ts
/**
 * AI Deliverable Tools (spec §10). `apply_template` is deliberately ABSENT:
 * template sets land in W05, and that action is the only approval-gated one in
 * this family (it arms unattended ticket creation). Everything here is tier 2
 * and ungated. Org scope is guarded at the SERVICE layer — every function takes
 * the DeliverableActor built from session auth and answers 404 NOT_FOUND (never
 * 403) for an org outside `accessibleOrgIds`.
 */
import type { AuthContext } from '../middleware/auth';
import type { AiTool, AiToolTier } from './aiTools';
import {
  listDeliverables, createDeliverable, updateDeliverable, deactivateDeliverable,
  listOccurrences, deliverOccurrence, waiveOccurrence, reopenOccurrence,
  rescheduleOccurrence, addEvidence, DeliverableServiceError, type DeliverableActor,
} from './serviceDeliverableService';
import { listKeyDates, createKeyDate, updateKeyDate, deleteKeyDate } from './orgKeyDateService';
import { missingParamsJson, zodErrorToJson } from './aiToolValidation';

const MANAGE_DELIVERABLES_REQUIRED: Record<string, readonly string[]> = {
  create: ['orgId', 'input'], update: ['orgId', 'deliverableId', 'patch'], deactivate: ['orgId', 'deliverableId'],
  deliver: ['orgId', 'occurrenceId'], waive: ['orgId', 'occurrenceId', 'reason'], reopen: ['orgId', 'occurrenceId'],
  reschedule: ['orgId', 'occurrenceId', 'dueAt'], link_evidence: ['orgId', 'occurrenceId', 'reportRunId'],
};
const MANAGE_KEY_DATES_REQUIRED: Record<string, readonly string[]> = {
  list: ['orgId'], create: ['orgId', 'input'], update: ['orgId', 'keyDateId', 'patch'], delete: ['orgId', 'keyDateId'],
};

function actorFromAuth(auth: AuthContext): DeliverableActor {
  return { userId: auth.user.id, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds };
}
function serviceErrorToJson(err: unknown): string | null {
  if (err instanceof DeliverableServiceError) {
    return JSON.stringify({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
  }
  return null;
}
const asJson = (err: unknown): string => {
  const json = serviceErrorToJson(err) ?? zodErrorToJson(err);
  if (json) return json;
  throw err;
};

export function registerDeliverableTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_deliverables', {
    tier: 2 as AiToolTier, deviceArgs: [],
    definition: {
      name: 'list_deliverables',
      description: 'List service deliverables (scheduled recurring service obligations such as a monthly sign-in log review) for one organization, with cadence, next due date and last delivery. Read-only.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Organization id (UUID)' },
          contractId: { type: 'string', description: 'Only deliverables attached to this contract (UUID)' },
          includeInactive: { type: 'boolean', description: 'Include deactivated deliverables (default false)' },
          occurrencesFor: { type: 'string', description: 'Also return the recent occurrences of this deliverable id' },
        },
        required: ['orgId'],
      },
    },
    handler: async (input, auth) => {
      const actor = actorFromAuth(auth);
      try {
        const orgId = String(input.orgId);
        const deliverables = await listDeliverables(orgId, {
          contractId: input.contractId ? String(input.contractId) : undefined,
          includeInactive: input.includeInactive === true,
        }, actor);
        const occurrences = input.occurrencesFor
          ? await listOccurrences(orgId, String(input.occurrencesFor), { limit: 24 }, actor) : undefined;
        return JSON.stringify({ deliverables, showing: deliverables.length, ...(occurrences ? { occurrences } : {}) });
      } catch (err) { return asJson(err); }
    },
  });

  aiTools.set('manage_deliverables', {
    tier: 2 as AiToolTier, deviceArgs: [],
    definition: {
      name: 'manage_deliverables',
      description: 'Create and manage service deliverables and their occurrences: create, update or deactivate a deliverable; deliver, waive, reopen or reschedule an occurrence; or link an existing report run as evidence.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['create','update','deactivate','deliver','waive','reopen','reschedule','link_evidence'] },
          orgId: { type: 'string', description: 'Organization id (UUID)' },
          deliverableId: { type: 'string' },
          occurrenceId: { type: 'string' },
          input: { type: 'object', description: 'Create payload (name, cadence, anchorDueDate, effectiveFrom, …)' },
          patch: { type: 'object', description: 'Update payload' },
          note: { type: 'string', description: 'Delivery note (deliver)' },
          reason: { type: 'string', description: 'Waiver reason (waive)' },
          dueAt: { type: 'string', description: 'New due date, YYYY-MM-DD (reschedule)' },
          reportRunId: { type: 'string', description: 'Report run to attach as evidence (link_evidence)' },
        },
        required: ['action'],
      },
    },
    handler: async (input, auth) => {
      const actor = actorFromAuth(auth);
      const action = String(input.action);
      const required = MANAGE_DELIVERABLES_REQUIRED[action];
      if (!required) return JSON.stringify({ error: `Unknown action: ${action}`, code: 'VALIDATION_ERROR' });
      const missing = missingParamsJson(input, action, required);
      if (missing) return missing;
      const orgId = String(input.orgId);
      try {
        switch (action) {
          case 'create':        return JSON.stringify(await createDeliverable(orgId, input.input as never, actor));
          case 'update':        return JSON.stringify(await updateDeliverable(orgId, String(input.deliverableId), input.patch as never, actor));
          case 'deactivate':    await deactivateDeliverable(orgId, String(input.deliverableId), actor); return JSON.stringify({ ok: true });
          case 'deliver':       return JSON.stringify(await deliverOccurrence(orgId, String(input.occurrenceId), { note: input.note ? String(input.note) : undefined }, actor));
          case 'waive':         return JSON.stringify(await waiveOccurrence(orgId, String(input.occurrenceId), { reason: String(input.reason) }, actor));
          case 'reopen':        return JSON.stringify(await reopenOccurrence(orgId, String(input.occurrenceId), actor));
          case 'reschedule':    return JSON.stringify(await rescheduleOccurrence(orgId, String(input.occurrenceId), { dueAt: String(input.dueAt) }, actor));
          case 'link_evidence': return JSON.stringify(await addEvidence(orgId, String(input.occurrenceId), { kind: 'report_run', reportRunId: String(input.reportRunId) }, actor));
          default:              return JSON.stringify({ error: `Unknown action: ${action}`, code: 'VALIDATION_ERROR' });
        }
      } catch (err) { return asJson(err); }
    },
  });

  aiTools.set('manage_key_dates', {
    tier: 2 as AiToolTier, deviceArgs: [],
    definition: {
      name: 'manage_key_dates',
      description: 'List, create, update or delete organization key dates (insurance renewals, vendor contract ends, compliance deadlines). Listing also returns upcoming contract end dates.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'delete'] },
          orgId: { type: 'string', description: 'Organization id (UUID)' },
          keyDateId: { type: 'string' },
          input: { type: 'object', description: 'Create payload (label, kind, date, recursAnnually, remindDaysBefore, …)' },
          patch: { type: 'object', description: 'Update payload' },
        },
        required: ['action', 'orgId'],
      },
    },
    handler: async (input, auth) => {
      const actor = actorFromAuth(auth);
      const action = String(input.action);
      const required = MANAGE_KEY_DATES_REQUIRED[action];
      if (!required) return JSON.stringify({ error: `Unknown action: ${action}`, code: 'VALIDATION_ERROR' });
      const missing = missingParamsJson(input, action, required);
      if (missing) return missing;
      const orgId = String(input.orgId);
      try {
        switch (action) {
          case 'list':   return JSON.stringify({ keyDates: await listKeyDates(orgId, actor, { includeContractEnds: true }) });
          case 'create': return JSON.stringify(await createKeyDate(orgId, input.input as never, actor));
          case 'update': return JSON.stringify(await updateKeyDate(orgId, String(input.keyDateId), input.patch as never, actor));
          case 'delete': await deleteKeyDate(orgId, String(input.keyDateId), actor); return JSON.stringify({ ok: true });
          default:       return JSON.stringify({ error: `Unknown action: ${action}`, code: 'VALIDATION_ERROR' });
        }
      } catch (err) { return asJson(err); }
    },
  });
}
```

- [ ] **Step 4: Wire the other three registration sites**

**Site 1** — `aiTools.ts`: add `import { registerDeliverableTools } from './aiToolsDeliverables';` beside line 80's contract import, and `registerDeliverableTools(aiTools);` beside line 294's `registerContractTools(aiTools);`.

**Site 2** — `aiToolSchemas.ts`, after the `manage_contracts` entry:

```ts
  list_deliverables: z.object({
    orgId: uuid, contractId: uuid.optional(), includeInactive: z.boolean().optional(), occurrencesFor: uuid.optional(),
  }),
  manage_deliverables: z.object({
    action: z.enum(['create','update','deactivate','deliver','waive','reopen','reschedule','link_evidence']),
    orgId: uuid.optional(), deliverableId: uuid.optional(), occurrenceId: uuid.optional(),
    input: z.record(z.string(), z.unknown()).optional(), patch: z.record(z.string(), z.unknown()).optional(),
    note: z.string().max(4000).optional(), reason: z.string().max(2000).optional(),
    dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), reportRunId: uuid.optional(),
  }),
  manage_key_dates: z.object({
    action: z.enum(['list', 'create', 'update', 'delete']),
    orgId: uuid, keyDateId: uuid.optional(),
    input: z.record(z.string(), z.unknown()).optional(), patch: z.record(z.string(), z.unknown()).optional(),
  }),
```

**Site 3** — `aiAgentSdkTools.ts`: add to `TOOL_TIERS` after `manage_contracts: 2,` (line 287):

```ts
  list_deliverables: 2,
  manage_deliverables: 2,       // no action escalates: apply_template is W05
  manage_key_dates: 2,
```

and three `tool('<name>', '<the same description>', { …the same zod shape as site 2… }, makeHandler('<name>', getAuth, onPreToolUse, onPostToolUse))` blocks after the `manage_contracts` block (line 2547).

**Site 4** — `aiGuardrails.ts`, after the `manage_contracts` block:

```ts
  list_deliverables: { resource: 'contracts', action: 'read' },
  manage_deliverables: {
    create: { resource: 'contracts', action: 'write' },
    update: { resource: 'contracts', action: 'write' },
    deactivate: { resource: 'contracts', action: 'write' },
    deliver: { resource: 'contracts', action: 'write' },
    waive: { resource: 'contracts', action: 'write' },
    reopen: { resource: 'contracts', action: 'write' },
    reschedule: { resource: 'contracts', action: 'write' },
    link_evidence: { resource: 'contracts', action: 'write' },
  },
  manage_key_dates: {
    list: { resource: 'contracts', action: 'read' },
    create: { resource: 'contracts', action: 'write' },
    update: { resource: 'contracts', action: 'write' },
    delete: { resource: 'contracts', action: 'write' },
  },
```

`contracts` is used, not a new `documents` resource, because W01's REST routes for deliverables **and key dates** already gate on `contracts:read` / `contracts:write` (W01 Task 10). The spec's `documents` resource arrives with `org_documents` in W03; splitting key dates off now would make the AI door disagree with the HTTP door.

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/aiToolsDeliverables.test.ts src/services/aiToolsRegistryParity.test.ts src/services/aiAgentSdkTools.registryParity.contract.test.ts && npx tsc --noEmit`
Expected: PASS. `aiToolsRegistryParity.test.ts` has deliberately empty exemption sets — a missing zod schema or permission entry fails it.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/aiToolsDeliverables.ts apps/api/src/services/aiToolsDeliverables.test.ts apps/api/src/services/aiTools.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiAgentSdkTools.ts apps/api/src/services/aiGuardrails.ts
git commit -m "feat(deliverables): MCP tools for deliverables, occurrences and key dates (W02)"
```

---

### Task 10: Integration suite on real Postgres

**Files:**
- Create: `apps/api/src/__tests__/integration/deliverableSweep.integration.test.ts`

Placement matters: `src/__tests__/integration/**/*.test.ts` is the wholesale glob of `vitest.integration.config.ts:11`. Anywhere else and the suite runs in **zero** CI jobs. Header pattern to follow — `aiAgentTicketTriage.integration.test.ts:35-70`: `import './setup'`, `getTestDb`, `createPartner`/`createOrganization`/`createUser` from `./db-utils`, and a hoisted spy replacing `publishEvent` so nothing needs a live stream consumer.

- [ ] **Step 1: Write the tests**

Ten cases, each proving something a mocked suite structurally cannot:

1. **Materialize → open.** Seed partner + org + a `monthly` deliverable anchored inside the lead window, with a `ticket_categories` row that **has** both SLA minutes set (otherwise the null assertion below is vacuous). Run `runDeliverableSweep(new Date('<today>'))`. Assert one occurrence `status='open'` with a non-null `ticket_id`; the ticket has `work_kind='deliverable'`, `source='api'`, `response_sla_minutes IS NULL`, `resolution_sla_minutes IS NULL`, and `due_date` equal to `due_at`.
2. **Real `ticket.status_changed` → `awaiting_evidence` → `delivered`.** `changeTicketStatus(ticketId, 'resolved', actor, { resolutionNote: 'Reviewed, no findings' })`, then `handleDeliverableTicketStatusChanged` with the real outbox payload `{ ticketId, from: 'open', to: 'resolved' }`. Assert `awaiting_evidence` (artifact required, no evidence). Then `addEvidence(...)` with a real report + run of the same org; assert `status='delivered'`, `delivered_via='ticket'`, `delivery_note='Reviewed, no findings'`, `delivered_by_user_id` = the resolving user.
3. **Miss after grace.** Occurrence `open` with `due_at = today − grace_days − 1`. Sweep. Assert `status='missed'` and `ticket_id` **unchanged**.
4. **Idempotent re-run.** Sweep twice with the same `asOf`. Assert occurrence count, ticket count for the org, and `ticket_id` all identical after the second run.
5. **Downtime catch-up.** Deliverable anchored 20 months ago, no occurrences. Sweep once. Assert exactly 12 rows (the cap), the oldest `status='missed'`, and **zero** tickets for any `missed` row.
6. **Service Management `off`.** Set `partners.service_management_mode='off'`, sweep. Assert the occurrence is `open` with `ticket_id IS NULL` and no ticket row exists.
7. **Cancelled-contract hook.** Create a contract, attach a deliverable with `effective_until IS NULL`, `cancelContract(...)`, then call `applyContractCancelledToDeliverables(contractId, today)` (the worker's job body). Assert `effective_until = today`. Flip the contract back to `active`, call again, assert nothing changes (replay safety).
8. **Auto-evidence generated once.** Seed a `reports` row of the org with `execution_scope_principal_kind='user'`, `execution_scope_user_id` = a real user with org access, `execution_scope_kind='unrestricted'`. Point `auto_evidence_report_id` at it and sweep on the due date. Assert exactly one `report_runs` row with `requested_by_kind='system'`, both requester ids NULL, `status='completed'`; exactly one `service_deliverable_evidence` row `kind='report_run'` with `report_id` and `report_run_id` set; exactly one `ticket_comments` row whose content is `Report attached, review and resolve`. Sweep again; assert all three counts are still 1.
9. **Key-date reminder once + annual roll-forward.** Key date with `remind_days_before=60`, `recurs_annually=true`, `date = today + 30 days`. Sweep twice. Assert exactly one reminder ticket (`work_kind='deliverable'`, subject starts `Key date:`) and `reminded_for_date = date`. Then set `date = today − 1 day`, run `rollForwardAnnualKeyDates(today)`: assert `date` advanced exactly one year and both `reminded_for_date` and `reminder_ticket_id` are NULL.
10. **Move-org refusal, with a positive control.** With case 1's occurrence linked, `moveTicketOrg(ticketId, otherOrgInSamePartner, actor)` rejects with `{ status: 409, code: 'DELIVERABLE_TICKET_PINNED' }`. Then null the occurrence's `ticket_id` and assert the same move **succeeds** — without the second half, a guard that always throws would pass.

- [ ] **Step 2: Run**

Run: `pnpm test-stack up` (repo root, once), then
`cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deliverableSweep.integration.test.ts`
Expected: PASS. **Confirm the reported count is 10.** A `0 tests` line is a stall, not green.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/deliverableSweep.integration.test.ts
git commit -m "test(deliverables): real-Postgres sweep, subscriber and auto-evidence suite (W02)"
```

---

### Task 11: Wave verification and PR

- [ ] **Step 1: Full API unit run** — `cd apps/api && npx vitest run` → green. Watch `ticketService.test.ts` (the `insertValues` shape changed) and any suite asserting the AI tool count.
- [ ] **Step 2: Contract suites** — `cd apps/api && npx vitest run src/jobs/scheduleRegistry.contract.test.ts src/jobs/workerReadinessCoverage.test.ts src/jobs/workerReadinessManifest.test.ts src/services/workerEntrypointClosure.contract.test.ts src/services/eventSubscribers.contract.test.ts src/services/aiToolsRegistryParity.test.ts src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/ticketOrgMoveLockOrder.test.ts` → green.
- [ ] **Step 3: Integration suites** (test stack up) — `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deliverableSweep.integration.test.ts src/__tests__/integration/serviceDeliverablesRls.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts` → green. W02 adds no tables and no columns, so the three registration suites should be untouched — a failure there means a table or column crept in and the wave is mis-scoped.
- [ ] **Step 4: Lint and typecheck** — `cd apps/api && npx tsc --noEmit`; `pnpm lint` at the repo root → clean.
- [ ] **Step 5: Manual smoke** — `pnpm wt-stack up`; create a deliverable due tomorrow with `lead_days = 7`, call `runDeliverableSweep(new Date())`, confirm the ticket appears in the web ticket list with **no** SLA badge, resolve it with a note, confirm W01's occurrence drawer shows `awaiting_evidence`, attach a report run, confirm it flips to Delivered.
- [ ] **Step 6: Tear down** — `pnpm test-stack down` and `pnpm wt-stack down`, then confirm nothing is left: `docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'`.
- [ ] **Step 7: PR** with `Closes #<sub-issue#>`, links to the spec and W01, and three sections: **Scheduling** (the `18 5 * * *` slot, why it was free, the two worker names in the readiness manifest); **Ticket integration** (`work_kind` on create, the SLA bypass and matching SLA-worker predicate, the move-org 409, and why `service_deliverable_occurrences` is deliberately NOT in `TICKET_ORG_DENORMALIZED_TABLES`); **Auto-evidence authority** (that `ReportExecutionAuthority` was NOT widened, that the definition owner's live authority is re-resolved exactly as `reportScheduleWorker` does, and that `requested_by_kind='system'` with both requester ids NULL is what `report_runs_requested_by_shape_chk` requires). Run `/pr-review-toolkit:review-pr`; act only on confirmed, consequential findings. Enqueue with `gh pr merge <N>` on green. Never `--admin`.

---

## Self-review

**Spec coverage.** §5.1 job + cron + system context + automation-eligible predicate (Task 1); §5.2 eligibility by effective window, contract status ignored (Task 1); §5.3 step 1 materialize with cap 12 and direct-`missed` catch-up (Task 2); step 2 open + ticket via `createTicket` with `source='api'`, `work_kind='deliverable'`, `due_date`, `assigned_to`, `category_id`, SLA explicitly null, plus the `off`-mode fallback with one warning per org per day (Task 3); step 3 auto-evidence once per occurrence with the internal ticket note (Task 4); step 4 miss after grace, ticket untouched (Task 2); step 5 key-date reminders deduped by `(id, date)` and annual roll-forward (Task 5); §5.4 contract-cancelled hook (Task 7); §6 all four subscriber arms plus idempotency, and the move-org 409 (Tasks 6, 8); §4.8 `work_kind` consumers — SLA defaults and the SLA worker (Task 3); §10 MCP tools, ungated, `apply_template` excluded (Task 9); §12 sweep error handling (Tasks 1, 3); §13's sweep integration list, every bullet (Task 10). Out of scope by design: portal (W04), `org_documents` and the `document` evidence kind (W03), template sets (W05), the ticket-list `work_kind` filter (W04/W01 UI).

**Placeholders.** None. Every step carries the code or the exact command. The five functions Task 1 imports before they exist are named stubs that Tasks 3–7 replace by body, never by name — the mechanism W01 used for its own four stubs.

**Type consistency.** `SweepDeliverable` is declared once (Task 2) and consumed identically in Tasks 1, 3 and 4. `materializeOccurrences`, `openOccurrence`, `markOccurrenceMissed` and `applyTicketStatusChange` keep W01's signatures character for character; the sweep-shaped siblings are new names (`openDueOccurrencesForDeliverable`, `markDueOccurrencesMissedForDeliverable`) rather than changed signatures. `AutoEvidenceOutcome`'s reason union is the same set in the type, the tests and the implementation.

**Three spec ambiguities resolved.**

1. **"The existing `contract.cancelled` consumer" does not exist.** `emitContractEvent` (`services/contractEvents.ts:31`) publishes to `contract-events`, whose own header (lines 5-9) calls it "an intentionally-unconsumed RESERVED bus … nothing reads them yet". W02 therefore *creates* the first consumer and corrects that header. Because the queue holds an unprocessed backlog, the handler re-reads the contract and applies nothing unless it is still `cancelled` — which also makes a reversed cancellation safe. `cancelContract` (`contractService.ts:1690-1698`) stores no cancellation timestamp, so `effective_until` is the date the event is **processed**.

2. **The spec's partner-timezone "today" does not match the sweep it cites.** §4 says today is "computed in the partner's configured timezone … exactly as the billing sweep does". The billing sweep does `asOf.toISOString().slice(0, 10)` (`contractWorker.ts:48`) and `contractMath.ts` exports no timezone helper. This plan pins UTC and says so, rather than inventing a helper the spec believes exists.

3. **A system principal cannot execute a report.** §5.3 step 3 says to generate the run "through the existing report runner (`requested_by_kind = 'system'`, added to the enum if absent)". There is no shared runner — create/generate/finalize is inlined at three sites — and `ReportExecutionAuthority` (`siteScope.ts:64-96`) deliberately excludes the system principal, with `assertExecutableAuthority` ending in `const exhaustive: never`. `requested_by_kind='system'` already exists, but its CHECK arm requires both requester ids NULL. Resolution: Task 4 reproduces `reportScheduleWorker`'s reauthorization sequence for **execution** scope and stamps **requester** as `system` with both ids NULL. Nothing in the authority union is widened. The two column families answer different questions — who could see the data, and who asked — and conflating them is exactly what the `siteScope.ts:84-90` docstring warns against.

**One deliberate addition beyond the spec**, flagged rather than buried: Task 3 pre-resolves `owner_user_id` and `ticket_category_id` against the org's partner and drops whichever no longer matches, with a warning. Without it, a technician leaving the partner makes `createTicket` throw `ASSIGNEE_WRONG_PARTNER` on every run and stalls that deliverable permanently and silently — a defect class the spec does not consider. Failing and retrying daily forever is strictly worse, and dropping a stale assignee is what the MSP would do by hand.
