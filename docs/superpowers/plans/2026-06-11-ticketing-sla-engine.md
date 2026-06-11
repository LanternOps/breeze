# Ticketing Phase 2 — SLA Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the dormant ticket SLA columns: stamp targets at create, pause the clock on `pending`/`on_hold`, detect breaches with a 1-minute BullMQ sweep, notify on breach, and surface SLA state in queue filters/sort/stats and the ticket UI.

**Architecture:** SLA targets are materialized onto the ticket row at create time (override → category default → priority default), so all queue filtering/sorting is plain SQL over `tickets` columns. A repeatable BullMQ sweep (`ticket-sla-monitor`, every 60s) stamps `sla_breached_at`/`sla_breach_reason` per target (one-shot each for `response` and `resolution`) and emits a new `ticket.sla_breached` lifecycle event consumed by the existing `ticketNotifyWorker`. Pause/resume lives in `changeTicketStatus` (the single status-change chokepoint). No new tables, no RLS changes — only an index migration.

**Tech Stack:** Hono + Drizzle + BullMQ (API), Zod validators in `packages/shared`, React islands (web), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-09-native-ticketing-design.md` — Phase 2 (§8): "SLA resolution chain, monitor job, pause logic, queue countdown + breaching-soon tab, breach notifications."

---

## Design decisions (resolving spec ambiguities)

The spec is silent or ambiguous on six points. These are the decisions this plan implements — do not re-litigate them mid-execution; if one proves wrong, stop and flag it.

| # | Decision | Rationale |
|---|---|---|
| D1 | **24×7 wall-clock SLA.** No business-hours calendars in Phase 2. | Spec never mentions business hours. Calendars change breach math retroactively — defer until a partner asks. |
| D2 | **Resolution chain collapses at create time.** `createTicket` stamps `response_sla_minutes`/`resolution_sla_minutes` from category defaults, else priority defaults. The sweep and all SQL read ticket columns only. Pre-Phase-2 tickets (null targets) simply have no SLA — no backfill. Category/priority changes after create do NOT restamp; `PATCH /tickets/:id` accepts explicit overrides. | The queue filter ("SLA state") and triage sort must be index-backed SQL; resolving a 3-level chain per row per query is not. Stamping is equivalent to the spec's chain for new tickets and far simpler. |
| D3 | **Per-target one-shot breach.** `sla_breach_reason` holds a comma-joined list (`response`, `resolution`). `sla_breached_at` records the FIRST breach and is never overwritten. Each target notifies at most once, ever (no re-fire after un-pause or reopen). | One column pair, two targets. CSV-in-reason avoids a schema change and is SQL-checkable for sweep idempotency. |
| D4 | **Pause is status-driven only.** Entering `pending`/`on_hold` sets `sla_paused_at = now()`; leaving (to ANY status, including `resolved`/`closed`) folds elapsed minutes into `sla_paused_minutes` and clears `sla_paused_at`. Customer replies do not affect the clock. | Exactly what spec §3 says; the resolve-from-paused fold keeps the columns consistent for reopen. |
| D5 | **Priority defaults (the chain's third link): `urgent` 60/240 min, `high` 240/1440 min, `normal`/`low` none.** Hardcoded constants in `ticketSla.ts`. | Spec names "priority default" but defines no values and no settings home. Hardcoding only urgent/high keeps breach noise near zero for partners who haven't configured categories, while making urgent tickets visibly tracked. Making them configurable is deferred. |
| D6 | **Breach notification = `ticket.sla_breached` TicketEvent → `ticketNotifyWorker` (in-app + email to the assignee) + an eventBus publish (`ticket.sla_breached`) mirroring `backupSlaWorker`'s breach publish.** Unassigned tickets get the eventBus publish only. | `alertService.createAlert` is rule/device-centric — a poor fit. The eventBus publish is the hook into `notificationRoutingRules`/channels the spec names, matching the `backup.sla_breach` precedent. Escalation-policy wiring is explicitly deferred by spec §8. |
| D7 | **At-risk = 80% of active elapsed time, computed (never stored), UI + filter only — no at-risk notifications.** `slaState` filter values: `ok` \| `at_risk` \| `breached` \| `breaching` (= at_risk ∪ breached; the queue tab uses this). | Spec defines 80% and a filter/tab, not an at-risk notification. |

**Out of scope (do not build):** business-hours calendars, escalation policies, configurable priority defaults, per-partner SLA policy objects/tables, at-risk notifications, dashboard widget (stats endpoint exposes the counts; widget is a follow-up), portal-side SLA visibility, e2e spec additions (tracked in `docs/testing/e2e-coverage-index.md` follow-ups), Phase 3 (time tracking/parts), Phase 4 (email-to-ticket).

---

## Delegation matrix

Per CLAUDE.md (Codex for isolated, well-scoped tasks; Claude keeps tenant isolation, auth/authz, cross-module work) and the standing preference that UI work runs in-session.

| Task | Owner | Codex reasoning effort |
|---|---|---|
| 1. `ticketSla.ts` pure helpers + tests | **Codex** | medium |
| 2. Stamp targets in `createTicket` | Claude | — |
| 3. Pause/resume in `changeTicketStatus` | Claude | — |
| 4. `ticket.sla_breached` event variant | **Codex** | low |
| 5. SLA monitor worker + registration | Claude | — |
| 6. Notify worker breach handling | **Codex** | high |
| 7. Validators + PATCH SLA override | **Codex** | medium |
| 8. List filter / triage sort / stats | **Codex** | high |
| 9. Index migration | **Codex** | low |
| 10. Web: `slaState()` pause-aware + SlaChip | Claude (in-session) | — |
| 11. Web: breaching tab server-driven + countdown | Claude (in-session) | — |
| 12. Web: workbench SLA timers rail | Claude (in-session) | — |

**Codex invocation template** (run from the execution worktree root; node 22 PATH prefix per repo convention):

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH codex exec "$(cat <<'EOF'
Read docs/superpowers/plans/2026-06-11-ticketing-sla-engine.md, Task N.
Implement it exactly as written: write the failing test first, run it (expect fail),
implement, run again (expect pass). Use the exact file paths, names, and code from
the plan. Run tests with:
  cd apps/api && npx vitest run <test files> --pool=forks --poolOptions.forks.singleFork=true
Do not commit.
EOF
)" --full-auto -m gpt-5.5 -c 'model_reasoning_effort="<level>"' -C "$(git rev-parse --show-toplevel)"
```

After every Codex task: review `git diff` (correctness, tenancy, conventions), run the task's tests yourself, then commit. Claude owns all commits.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `apps/api/src/services/ticketSla.ts` | Create | Pure SLA math: priority defaults, target resolution, breach-reason CSV helpers, state computation. No DB, no IO. |
| `apps/api/src/services/ticketSla.test.ts` | Create | Table-driven tests for the above. |
| `apps/api/src/services/ticketService.ts` | Modify | Stamp targets at create (~:207-237); pause/resume in `changeTicketStatus` (~:288-310); SLA override fields in `updateTicketFields`. |
| `apps/api/src/services/ticketEvents.ts` | Modify | Add `ticket.sla_breached` to the `TicketEvent` union (:19-25). |
| `apps/api/src/jobs/ticketSlaWorker.ts` | Create | Repeatable 60s breach sweep; stamps + emits. Modeled on `approvalExpiryReaper.ts`. |
| `apps/api/src/jobs/ticketSlaWorker.test.ts` | Create | Sweep SQL shape + emit behavior tests (Drizzle mocks). |
| `apps/api/src/jobs/ticketNotifyWorker.ts` | Modify | Handle `ticket.sla_breached`: in-app + email to assignee. |
| `apps/api/src/index.ts` | Modify | Register `initializeTicketSlaWorker`/`shutdownTicketSlaWorker` beside `ticketNotifyWorker` (~:1053). |
| `packages/shared/src/validators/tickets.ts` | Modify | `slaState` in `listTicketsQuerySchema`; `responseSlaMinutes`/`resolutionSlaMinutes` in `updateTicketSchema`. |
| `apps/api/src/routes/tickets/tickets.ts` | Modify | SLA filter conditions, SLA-aware triage sort, `atRisk` stat, projection additions. |
| `apps/api/migrations/2026-06-12-a-ticket-sla-indexes.sql` | Create | Partial indexes for sweep + breached filtering. (Re-date to the actual execution date.) |
| `apps/web/src/components/tickets/ticketConfig.ts` | Modify | Pause/response-aware `slaState()`, new `paused` kind, `TicketSummary` fields. |
| `apps/web/src/components/tickets/SlaChip.tsx` | Modify | Render `paused` state. |
| `apps/web/src/components/tickets/TicketsPage.tsx` | Modify | Server-driven breaching tab (`slaState=breaching`). |
| `apps/web/src/components/tickets/SlaTimers.tsx` | Create | Response/resolution timers for the detail right rail. |
| `apps/web/src/components/tickets/TicketWorkbench.tsx` | Modify | Mount `SlaTimers`. |

---

## Task 0: Worktree + baseline

- [ ] **Step 1: Isolated workspace.** If not already in one (this plan was authored in `worktree-ticketing-sla-plan`, which can be reused), create via the native worktree tool. Then:

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm install
```

- [ ] **Step 2: Baseline the affected test files** (full-suite parallel runs are known-flaky; use single-fork on affected files and trust CI for the rest):

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run \
  src/services/ticketService.test.ts src/services/ticketEvents.test.ts \
  src/routes/tickets/tickets.test.ts src/jobs/ticketNotifyWorker.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true
```

Expected: all pass. If not, stop and report before changing anything.

---

## Task 1: `ticketSla.ts` pure helpers — **Codex (medium)**

**Files:**
- Create: `apps/api/src/services/ticketSla.ts`
- Test: `apps/api/src/services/ticketSla.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/ticketSla.test.ts
import { describe, it, expect } from 'vitest';
import {
  PRIORITY_SLA_DEFAULTS,
  SLA_AT_RISK_RATIO,
  resolveSlaTargets,
  breachedTargets,
  appendBreachTarget
} from './ticketSla';

describe('PRIORITY_SLA_DEFAULTS', () => {
  it('tracks urgent and high only (D5)', () => {
    expect(PRIORITY_SLA_DEFAULTS.urgent).toEqual({ responseMinutes: 60, resolutionMinutes: 240 });
    expect(PRIORITY_SLA_DEFAULTS.high).toEqual({ responseMinutes: 240, resolutionMinutes: 1440 });
    expect(PRIORITY_SLA_DEFAULTS.normal).toEqual({ responseMinutes: null, resolutionMinutes: null });
    expect(PRIORITY_SLA_DEFAULTS.low).toEqual({ responseMinutes: null, resolutionMinutes: null });
  });
});

describe('resolveSlaTargets', () => {
  const cases: Array<{ name: string; input: Parameters<typeof resolveSlaTargets>[0]; expected: { responseMinutes: number | null; resolutionMinutes: number | null } }> = [
    { name: 'override wins over category and priority',
      input: { overrideResponseMinutes: 5, overrideResolutionMinutes: 10, categoryResponseMinutes: 30, categoryResolutionMinutes: 60, priority: 'urgent' },
      expected: { responseMinutes: 5, resolutionMinutes: 10 } },
    { name: 'category wins over priority',
      input: { categoryResponseMinutes: 30, categoryResolutionMinutes: 60, priority: 'urgent' },
      expected: { responseMinutes: 30, resolutionMinutes: 60 } },
    { name: 'priority default fallback for urgent',
      input: { priority: 'urgent' },
      expected: { responseMinutes: 60, resolutionMinutes: 240 } },
    { name: 'normal priority with no category yields no SLA',
      input: { priority: 'normal' },
      expected: { responseMinutes: null, resolutionMinutes: null } },
    { name: 'per-target independence: category sets resolution only, response falls to priority',
      input: { categoryResolutionMinutes: 90, priority: 'high' },
      expected: { responseMinutes: 240, resolutionMinutes: 90 } }
  ];
  for (const c of cases) {
    it(c.name, () => expect(resolveSlaTargets(c.input)).toEqual(c.expected));
  }
});

describe('breachedTargets / appendBreachTarget', () => {
  it('parses null/empty as no targets', () => {
    expect(breachedTargets(null).size).toBe(0);
    expect(breachedTargets('').size).toBe(0);
  });
  it('parses CSV and ignores unknown entries', () => {
    expect([...breachedTargets('response')]).toEqual(['response']);
    expect([...breachedTargets('response,resolution')].sort()).toEqual(['resolution', 'response'].sort());
    expect([...breachedTargets('response,bogus')]).toEqual(['response']);
  });
  it('appends without duplicating', () => {
    expect(appendBreachTarget(null, 'response')).toBe('response');
    expect(appendBreachTarget('response', 'resolution')).toBe('response,resolution');
    expect(appendBreachTarget('response', 'response')).toBe('response');
  });
  it('does not confuse response with resolution substrings', () => {
    expect(breachedTargets('resolution').has('response')).toBe(false);
  });
});

describe('SLA_AT_RISK_RATIO', () => {
  it('is 80% per spec §3', () => expect(SLA_AT_RISK_RATIO).toBe(0.8);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/api && npx vitest run src/services/ticketSla.test.ts --pool=forks --poolOptions.forks.singleFork=true
```

Expected: FAIL — module `./ticketSla` not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/ticketSla.ts
// Pure SLA math for native ticketing Phase 2. No DB access, no IO — keep it
// trivially unit-testable. The SQL twins of these rules live in
// jobs/ticketSlaWorker.ts (sweep) and routes/tickets/tickets.ts (filters);
// change them together.

export type TicketSlaPriority = 'low' | 'normal' | 'high' | 'urgent';
export type SlaTargetKind = 'response' | 'resolution';

/**
 * Third link of the resolution chain (D5): only urgent/high carry built-in
 * targets so partners without category SLAs aren't flooded with breaches.
 */
export const PRIORITY_SLA_DEFAULTS: Record<TicketSlaPriority, { responseMinutes: number | null; resolutionMinutes: number | null }> = {
  urgent: { responseMinutes: 60, resolutionMinutes: 240 },
  high: { responseMinutes: 240, resolutionMinutes: 1440 },
  normal: { responseMinutes: null, resolutionMinutes: null },
  low: { responseMinutes: null, resolutionMinutes: null }
};

/** At-risk begins at 80% of the target elapsed (spec §3). */
export const SLA_AT_RISK_RATIO = 0.8;

export interface ResolveSlaTargetsInput {
  overrideResponseMinutes?: number | null;
  overrideResolutionMinutes?: number | null;
  categoryResponseMinutes?: number | null;
  categoryResolutionMinutes?: number | null;
  priority: TicketSlaPriority;
}

/** Spec §3 chain, per target: ticket override → category default → priority default. */
export function resolveSlaTargets(input: ResolveSlaTargetsInput): { responseMinutes: number | null; resolutionMinutes: number | null } {
  const defaults = PRIORITY_SLA_DEFAULTS[input.priority];
  return {
    responseMinutes: input.overrideResponseMinutes ?? input.categoryResponseMinutes ?? defaults.responseMinutes,
    resolutionMinutes: input.overrideResolutionMinutes ?? input.categoryResolutionMinutes ?? defaults.resolutionMinutes
  };
}

const SLA_TARGET_KINDS: ReadonlySet<string> = new Set(['response', 'resolution']);

/** Parse the sla_breach_reason CSV (D3) into the set of already-breached targets. */
export function breachedTargets(reason: string | null | undefined): Set<SlaTargetKind> {
  const out = new Set<SlaTargetKind>();
  for (const part of (reason ?? '').split(',')) {
    const trimmed = part.trim();
    if (SLA_TARGET_KINDS.has(trimmed)) out.add(trimmed as SlaTargetKind);
  }
  return out;
}

/** Append a target to the CSV, idempotently. Mirrors the SQL CASE in ticketSlaWorker. */
export function appendBreachTarget(reason: string | null | undefined, target: SlaTargetKind): string {
  const existing = breachedTargets(reason);
  if (existing.has(target)) return reason ?? target;
  return existing.size === 0 ? target : `${[...existing].join(',')},${target}`;
}
```

- [ ] **Step 4: Run tests — expect PASS** (same command as Step 2).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketSla.ts apps/api/src/services/ticketSla.test.ts
git commit -m "feat(tickets): SLA target resolution + breach-reason helpers (phase 2)"
```

---

## Task 2: Stamp SLA targets at create — **Claude**

**Files:**
- Modify: `apps/api/src/services/ticketService.ts` (`assertCategoryInPartner` :139-155, `createTicket` :178-264)
- Test: `apps/api/src/services/ticketService.test.ts`

- [ ] **Step 1: Write the failing tests** — add to the `createTicket` describe block in `ticketService.test.ts`, following the file's existing Drizzle-mock pattern (mock the category select to return SLA fields):

```ts
it('stamps SLA targets from the category when set', async () => {
  // arrange mocks: org row; category row { id, partnerId, responseSlaMinutes: 30, resolutionSlaMinutes: 120 }
  const ticket = await createTicket({ orgId, subject: 'x', categoryId, priority: 'urgent', source: 'manual' }, actor);
  const inserted = capturedInsertValues(); // per the file's existing mock-capture helper
  expect(inserted.responseSlaMinutes).toBe(30);
  expect(inserted.resolutionSlaMinutes).toBe(120);
});

it('falls back to priority defaults when the category has no SLA', async () => {
  // category row with null SLA fields, priority 'urgent'
  expect(inserted.responseSlaMinutes).toBe(60);
  expect(inserted.resolutionSlaMinutes).toBe(240);
});

it('stamps no SLA for normal priority without category targets', async () => {
  // no categoryId, priority 'normal'
  expect(inserted.responseSlaMinutes).toBeNull();
  expect(inserted.resolutionSlaMinutes).toBeNull();
});
```

(Adapt assertion plumbing to the file's existing mock-capture style — `ticketService.test.ts` already captures `insert().values()` args in its create tests.)

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/api && npx vitest run src/services/ticketService.test.ts --pool=forks --poolOptions.forks.singleFork=true
```

Expected: new tests FAIL — `responseSlaMinutes` undefined on insert values.

- [ ] **Step 3: Implement.** In `assertCategoryInPartner`, widen the select and return the row:

```ts
async function assertCategoryInPartner(categoryId: string, partnerId: string | null) {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          id: ticketCategories.id,
          partnerId: ticketCategories.partnerId,
          responseSlaMinutes: ticketCategories.responseSlaMinutes,
          resolutionSlaMinutes: ticketCategories.resolutionSlaMinutes
        })
        .from(ticketCategories)
        .where(eq(ticketCategories.id, categoryId))
        .limit(1)
    )
  );
  const category = rows[0];
  if (!category) throw new TicketServiceError('Category not found', 404, 'CATEGORY_NOT_FOUND');
  throwIfPartnerUnresolvable(partnerId);
  if (category.partnerId !== partnerId) {
    throw new TicketServiceError('Category must belong to the same partner as the ticket', 400, 'CATEGORY_WRONG_PARTNER');
  }
  return category;
}
```

In `createTicket`, capture the category and stamp targets (import `resolveSlaTargets` from `./ticketSla`):

```ts
let category: Awaited<ReturnType<typeof assertCategoryInPartner>> | null = null;
if (input.categoryId) {
  category = await assertCategoryInPartner(input.categoryId, org.partnerId);
}

const slaTargets = resolveSlaTargets({
  categoryResponseMinutes: category?.responseSlaMinutes ?? null,
  categoryResolutionMinutes: category?.resolutionSlaMinutes ?? null,
  priority: input.priority ?? 'normal'
});
```

and in `insertValues` add:

```ts
    responseSlaMinutes: slaTargets.responseMinutes,
    resolutionSlaMinutes: slaTargets.resolutionMinutes,
```

(`updateTicketFields` callers that pass `categoryId` do NOT restamp — D2.)

- [ ] **Step 4: Run tests — expect PASS** (same command; also re-run `aiToolsTicketing.test.ts` and `routes/portal/tickets.test.ts` since they exercise `createTicket`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.test.ts
git commit -m "feat(tickets): stamp effective SLA targets at ticket create (D2 chain)"
```

---

## Task 3: SLA pause/resume on status change — **Claude**

**Files:**
- Modify: `apps/api/src/services/ticketService.ts` (`changeTicketStatus` :271-353)
- Test: `apps/api/src/services/ticketService.test.ts`

- [ ] **Step 1: Write the failing tests** (in the `changeTicketStatus` describe block; mock ticket rows carry `slaPausedAt`/`slaPausedMinutes`):

```ts
it('sets slaPausedAt when entering pending', async () => {
  // ticket: status 'open', slaPausedAt null
  // act: changeTicketStatus(id, 'pending', { pendingReason: 'waiting on customer' }, actor)
  expect(capturedUpdateSet().slaPausedAt).toBeInstanceOf(Date);
});

it('folds paused time into slaPausedMinutes when leaving on_hold', async () => {
  // ticket: status 'on_hold', slaPausedAt = 30 minutes ago, slaPausedMinutes = 10
  // act: changeTicketStatus(id, 'open', {}, actor)
  const set = capturedUpdateSet();
  expect(set.slaPausedAt).toBeNull();
  expect(set.slaPausedMinutes).toBe(40); // 10 accumulated + 30 elapsed
});

it('folds pause on resolve directly from pending', async () => {
  // ticket: status 'pending', slaPausedAt = 5 minutes ago, slaPausedMinutes = 0
  // act: changeTicketStatus(id, 'resolved', { resolutionNote: 'done' }, actor)
  const set = capturedUpdateSet();
  expect(set.slaPausedAt).toBeNull();
  expect(set.slaPausedMinutes).toBe(5);
});

it('does not touch pause fields for open -> resolved', async () => {
  const set = capturedUpdateSet();
  expect('slaPausedAt' in set).toBe(false);
  expect('slaPausedMinutes' in set).toBe(false);
});
```

Use `vi.useFakeTimers()` / `vi.setSystemTime()` for deterministic elapsed-minute math (the file already imports vitest fake timers in other suites; if not, add it per `breeze-testing` conventions).

- [ ] **Step 2: Run to verify failure** — same vitest command as Task 2. Expected: FAIL (pause fields never set).

- [ ] **Step 3: Implement.** In `changeTicketStatus`, after the existing `patch` if/else chain (after line ~310, before the CAS update):

```ts
  // SLA clock pause/resume (spec §3, decision D4): the clock pauses while the
  // ticket sits in pending/on_hold. Fold elapsed pause time on ANY exit —
  // including resolve/close — so reopen resumes from a consistent ledger.
  const wasPaused = fromStatus === 'pending' || fromStatus === 'on_hold';
  const willBePaused = toStatus === 'pending' || toStatus === 'on_hold';
  if (!wasPaused && willBePaused) {
    patch.slaPausedAt = now;
  } else if (wasPaused && !willBePaused) {
    if (ticket.slaPausedAt) {
      const elapsedMinutes = Math.max(0, Math.round((now.getTime() - new Date(ticket.slaPausedAt).getTime()) / 60_000));
      patch.slaPausedMinutes = (ticket.slaPausedMinutes ?? 0) + elapsedMinutes;
    }
    patch.slaPausedAt = null;
  }
```

(`pending → on_hold` hits neither branch — clock stays paused with the original `slaPausedAt`, which is correct.)

- [ ] **Step 4: Run tests — expect PASS.** Also re-run `routes/tickets/tickets.test.ts` and `routes/tickets/bulk.test.ts` (status routes).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.test.ts
git commit -m "feat(tickets): pause/resume SLA clock on pending/on_hold transitions (D4)"
```

---

## Task 4: `ticket.sla_breached` event variant — **Codex (low)**

**Files:**
- Modify: `apps/api/src/services/ticketEvents.ts` (:19-25)
- Test: `apps/api/src/services/ticketEvents.test.ts` (and `ticketEventsContract.test.ts` if it enumerates event types)

- [ ] **Step 1: Write the failing test** — extend the existing emit test pattern:

```ts
it('enqueues ticket.sla_breached with target payload', async () => {
  await emitTicketEvent({
    type: 'ticket.sla_breached',
    ticketId: 't1', orgId: 'o1', partnerId: 'p1', actorUserId: null,
    payload: { target: 'response', internalNumber: 'T-2026-0001', subject: 'Printer on fire', assigneeId: 'u1' }
  });
  expect(mockQueueAdd).toHaveBeenCalledWith('ticket.sla_breached', expect.objectContaining({ type: 'ticket.sla_breached' }), expect.anything());
});
```

- [ ] **Step 2: Run — expect FAIL** (type error / union rejects the variant):

```bash
cd apps/api && npx vitest run src/services/ticketEvents.test.ts src/services/ticketEventsContract.test.ts --pool=forks --poolOptions.forks.singleFork=true
```

- [ ] **Step 3: Implement** — add to the `TicketEvent` union after `ticket.updated`:

```ts
  | { type: 'ticket.sla_breached'; payload: { target: 'response' | 'resolution'; internalNumber: string | null; subject: string; assigneeId: string | null } }
```

If `ticketEventsContract.test.ts` asserts the closed set of event types, add `'ticket.sla_breached'` there too.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketEvents.ts apps/api/src/services/ticketEvents.test.ts apps/api/src/services/ticketEventsContract.test.ts
git commit -m "feat(tickets): add ticket.sla_breached lifecycle event"
```

---

## Task 5: SLA monitor worker — **Claude**

**Files:**
- Create: `apps/api/src/jobs/ticketSlaWorker.ts`
- Create: `apps/api/src/jobs/ticketSlaWorker.test.ts`
- Modify: `apps/api/src/index.ts` (worker init/shutdown registration, beside `ticketNotifyWorker` ~:1053)

- [ ] **Step 1: Write the failing tests** — mirror `approvalExpiryReaper`'s test structure (mock `bullmq`, mock `../db` with a captured `db.execute`, mock `ticketEvents`):

```ts
// apps/api/src/jobs/ticketSlaWorker.test.ts — key cases:
it('stamps response and resolution breaches and returns rows tagged by target', async () => {
  // db.execute resolves [{ id, org_id, partner_id, internal_number, subject, assigned_to }] for response, [] for resolution
  const rows = await sweepTicketSlaBreaches();
  expect(rows).toHaveLength(1);
  expect(rows[0].target).toBe('response');
});

it('emits ticket.sla_breached per stamped row, outside the system DB context', async () => {
  // run the worker handler; assert emitTicketEvent called with matching payload
  // and that withSystemDbAccessContext mock resolved BEFORE the first emit call
});

it('sweep SQL excludes paused, already-breached-target, and non-active tickets', () => {
  // snapshot/regex the generated SQL: must contain status IN ('new','open'),
  // sla_paused_at IS NULL, string_to_array guard, FOR UPDATE SKIP LOCKED
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found):

```bash
cd apps/api && npx vitest run src/jobs/ticketSlaWorker.test.ts --pool=forks --poolOptions.forks.singleFork=true
```

- [ ] **Step 3: Implement**

```ts
// apps/api/src/jobs/ticketSlaWorker.ts
import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { emitTicketEvent } from '../services/ticketEvents';
import { getEventBus } from '../services/eventBus';

/**
 * Ticket SLA monitor (spec §3, Phase 2): every 60s, stamp sla_breached_at /
 * sla_breach_reason on active tickets whose response or resolution deadline
 * has passed, then emit ticket.sla_breached per stamped target.
 *
 * Targets are one-shot (D3): sla_breach_reason is a CSV of breached targets and
 * the sweep's WHERE excludes targets already present. Deadlines are wall-clock
 * (D1): created_at + (target_minutes + sla_paused_minutes). Paused tickets
 * (sla_paused_at set / status pending|on_hold) are skipped entirely.
 *
 * DB work runs inside withSystemDbAccessContext (one short transaction);
 * event emission happens AFTER the context exits (#1105 pool-poison rule).
 */

const QUEUE_NAME = 'ticket-sla-monitor';
const SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_BREACHES_PER_RUN = 200; // per target per sweep

type SlaSweepJobData = { type: 'sla-sweep'; queuedAt: string };

export type BreachedTicketRow = {
  id: string;
  org_id: string;
  partner_id: string | null;
  internal_number: string | null;
  subject: string;
  assigned_to: string | null;
};

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error('[TicketSlaWorker] withSystemDbAccessContext not available');
  }
  return withSystem(fn);
};

let slaQueue: Queue<SlaSweepJobData> | null = null;
let slaWorker: Worker<SlaSweepJobData> | null = null;

function getQueue(): Queue<SlaSweepJobData> {
  if (!slaQueue) {
    slaQueue = new Queue<SlaSweepJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return slaQueue;
}

function extractRows<T>(result: unknown): T[] {
  const maybe = result as { rows?: T[] };
  return maybe.rows ?? (result as T[]);
}

async function stampBreaches(target: 'response' | 'resolution'): Promise<BreachedTicketRow[]> {
  const targetColumn = target === 'response' ? sql.raw('response_sla_minutes') : sql.raw('resolution_sla_minutes');
  const unmetCondition = target === 'response'
    ? sql.raw('first_response_at IS NULL')
    : sql.raw('resolved_at IS NULL');

  const result = await db.execute<BreachedTicketRow>(sql`
    WITH due AS (
      SELECT id
      FROM tickets
      WHERE status IN ('new', 'open')
        AND sla_paused_at IS NULL
        AND ${unmetCondition}
        AND ${targetColumn} IS NOT NULL
        AND NOT (${sql.raw(`'${target}'`)} = ANY(string_to_array(COALESCE(sla_breach_reason, ''), ',')))
        AND now() >= created_at
          + (${targetColumn} + COALESCE(sla_paused_minutes, 0)) * interval '1 minute'
      ORDER BY created_at ASC
      LIMIT ${MAX_BREACHES_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE tickets t
    SET sla_breached_at = COALESCE(t.sla_breached_at, now()),
        sla_breach_reason = CASE
          WHEN COALESCE(t.sla_breach_reason, '') = '' THEN ${target}
          ELSE t.sla_breach_reason || ',' || ${target}
        END,
        updated_at = now()
    FROM due
    WHERE t.id = due.id
    RETURNING t.id, t.org_id, t.partner_id, t.internal_number, t.subject, t.assigned_to;
  `);
  return extractRows<BreachedTicketRow>(result);
}

export async function sweepTicketSlaBreaches(): Promise<Array<BreachedTicketRow & { target: 'response' | 'resolution' }>> {
  const response = await stampBreaches('response');
  const resolution = await stampBreaches('resolution');
  if (response.length === MAX_BREACHES_PER_RUN || resolution.length === MAX_BREACHES_PER_RUN) {
    console.warn(`[TicketSlaWorker] Hit ${MAX_BREACHES_PER_RUN}-row cap — breach backlog may be growing`);
  }
  return [
    ...response.map((r) => ({ ...r, target: 'response' as const })),
    ...resolution.map((r) => ({ ...r, target: 'resolution' as const }))
  ];
}

async function notifyBreaches(rows: Array<BreachedTicketRow & { target: 'response' | 'resolution' }>): Promise<void> {
  for (const row of rows) {
    await emitTicketEvent({
      type: 'ticket.sla_breached',
      ticketId: row.id,
      orgId: row.org_id,
      partnerId: row.partner_id,
      actorUserId: null,
      payload: { target: row.target, internalNumber: row.internal_number, subject: row.subject, assigneeId: row.assigned_to }
    });
    try {
      // Routing-rule hook, mirroring backupSlaWorker's breach publish.
      // VERIFY the publish() signature against backupSlaWorker.ts before relying on it.
      getEventBus().publish('ticket.sla_breached', row.org_id, {
        ticketId: row.id,
        internalNumber: row.internal_number,
        subject: row.subject,
        target: row.target,
        assigneeId: row.assigned_to
      }, 'ticket-sla-monitor');
    } catch (err) {
      console.error('[TicketSlaWorker] eventBus publish failed:', err instanceof Error ? err.message : err);
    }
  }
}

function createWorker(): Worker<SlaSweepJobData> {
  return new Worker<SlaSweepJobData>(
    QUEUE_NAME,
    async (_job: Job<SlaSweepJobData>) => {
      try {
        // DB stamping inside the system context; notifications after it exits.
        const rows = await runWithSystemDbAccess(sweepTicketSlaBreaches);
        if (rows.length > 0) {
          console.log(`[TicketSlaWorker] Stamped ${rows.length} SLA breach(es)`);
          await notifyBreaches(rows);
        }
        return { breached: rows.length };
      } catch (err) {
        console.error('[TicketSlaWorker] Sweep failed:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    { connection: getBullMQConnection(), concurrency: 1 }
  );
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();
  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === 'sla-sweep') {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(
    'sla-sweep',
    { type: 'sla-sweep', queuedAt: new Date().toISOString() },
    {
      // jobId rule: '-' separators, 0 colons (BullMQ repeat-key parsing, #1118)
      jobId: 'ticket-sla-monitor-sweep',
      repeat: { every: SWEEP_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 }
    }
  );
}

export async function initializeTicketSlaWorker(): Promise<void> {
  if (slaWorker) return;
  slaWorker = createWorker();
  slaWorker.on('error', (error) => {
    console.error('[TicketSlaWorker] Worker error:', error);
    captureException(error);
  });
  slaWorker.on('failed', (job, error) => {
    console.error(`[TicketSlaWorker] Job ${job?.id} failed:`, error);
    captureException(error);
  });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await slaWorker.close();
    slaWorker = null;
    throw err;
  }
  console.log('[TicketSlaWorker] Initialized');
}

export async function shutdownTicketSlaWorker(): Promise<void> {
  const worker = slaWorker;
  const queue = slaQueue;
  slaWorker = null;
  slaQueue = null;
  if (worker) {
    try { await worker.close(); } catch (err) { console.error('[TicketSlaWorker] Error closing worker:', err); }
  }
  if (queue) {
    try { await queue.close(); } catch (err) { console.error('[TicketSlaWorker] Error closing queue:', err); }
  }
}
```

Register in `apps/api/src/index.ts`: import `initializeTicketSlaWorker`/`shutdownTicketSlaWorker` and add them immediately after the `ticketNotifyWorker` entries (init ~:1053 and the corresponding shutdown block — follow exactly how `ticketNotifyWorker` is wired).

- [ ] **Step 4: Run — expect PASS.** Also boot the dev stack briefly and confirm `[TicketSlaWorker] Initialized` in API logs.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/ticketSlaWorker.ts apps/api/src/jobs/ticketSlaWorker.test.ts apps/api/src/index.ts
git commit -m "feat(tickets): SLA breach monitor worker (60s sweep, one-shot per target)"
```

---

## Task 6: Breach notifications in `ticketNotifyWorker` — **Codex (high)**

**Files:**
- Modify: `apps/api/src/jobs/ticketNotifyWorker.ts`
- Test: `apps/api/src/jobs/ticketNotifyWorker.test.ts`

- [ ] **Step 1: Write the failing tests** (follow the file's existing per-event-type test pattern):

```ts
it('ticket.sla_breached notifies the assignee in-app and by email', async () => {
  // ticket row with assignedTo = 'u1'; user row with email
  // expect userNotifications insert: type/category per the file's existing convention,
  //   title like 'SLA breached: T-2026-0001', body naming the target ('response')
  // expect EmailService.sendEmail called once to the assignee's address
});

it('ticket.sla_breached with no assignee creates no notification and no email', async () => {});

it('ticket.sla_breached throws when the ticket row is missing (retryable, pre-commit contract)', async () => {});
```

- [ ] **Step 2: Run — expect FAIL:**

```bash
cd apps/api && npx vitest run src/jobs/ticketNotifyWorker.test.ts --pool=forks --poolOptions.forks.singleFork=true
```

- [ ] **Step 3: Implement.** Add a `ticket.sla_breached` case to `handleTicketEvent`'s switch, copying the structure of the existing `ticket.assigned` case exactly:
  - All DB reads + `userNotifications` insert INSIDE `runWithSystemDbAccess`; email payloads accumulated and sent AFTER the context exits (the file's existing #1105 pattern — do not deviate).
  - Missing ticket → throw (retryable). Missing/null assignee → return without action (terminal, like the existing missing-assignee handling).
  - Email subject: `` `SLA breached: ${internalNumber ?? ticketId} — ${subject}` ``; body states which target (`response` or `resolution`) breached, using `escapeHtml` from `services/emailLayout` like the file's other emails.
  - Do NOT email the requester/`submitterEmail` — breach notifications are internal only (spec §7: portal stays unchanged).

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/ticketNotifyWorker.ts apps/api/src/jobs/ticketNotifyWorker.test.ts
git commit -m "feat(tickets): in-app + email breach notifications to assignee"
```

---

## Task 7: SLA override via PATCH + validator — **Codex (medium)**

**Files:**
- Modify: `packages/shared/src/validators/tickets.ts` (`updateTicketSchema` :20-28)
- Modify: `apps/api/src/services/ticketService.ts` (`UpdateTicketFieldsInput` :355-363, `updateTicketFields` ~:388-470, `UPDATE_FIELD_LABELS` :366)
- Test: `packages/shared/src/validators/tickets.test.ts`, `apps/api/src/services/ticketService.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/validators/tickets.test.ts
it('updateTicketSchema accepts SLA override minutes', () => {
  expect(updateTicketSchema.parse({ responseSlaMinutes: 30, resolutionSlaMinutes: 120 }))
    .toEqual({ responseSlaMinutes: 30, resolutionSlaMinutes: 120 });
  expect(updateTicketSchema.parse({ responseSlaMinutes: null }).responseSlaMinutes).toBeNull();
});
it('updateTicketSchema rejects non-positive SLA minutes', () => {
  expect(() => updateTicketSchema.parse({ responseSlaMinutes: 0 })).toThrow();
  expect(() => updateTicketSchema.parse({ resolutionSlaMinutes: -5 })).toThrow();
});

// apps/api/src/services/ticketService.test.ts
it('updateTicketFields persists SLA overrides and labels them in the feed comment', async () => {
  // act: updateTicketFields(id, { responseSlaMinutes: 15 }, actor)
  // assert update .set() contains responseSlaMinutes: 15
  // assert system comment content mentions 'response SLA'
});
```

- [ ] **Step 2: Run — expect FAIL:**

```bash
cd packages/shared && npx vitest run src/validators/tickets.test.ts
cd ../../apps/api && npx vitest run src/services/ticketService.test.ts --pool=forks --poolOptions.forks.singleFork=true
```

- [ ] **Step 3: Implement.**
  - Validator — add to `updateTicketSchema`:

```ts
  responseSlaMinutes: z.number().int().positive().nullable().optional(),
  resolutionSlaMinutes: z.number().int().positive().nullable().optional()
```

  - Service — add both fields to `UpdateTicketFieldsInput`, to the field-patch handling in `updateTicketFields` (same null-vs-undefined semantics as `dueDate`), and to `UPDATE_FIELD_LABELS`:

```ts
  responseSlaMinutes: 'response SLA',
  resolutionSlaMinutes: 'resolution SLA'
```

  The PATCH route already passes the validated body through to `updateTicketFields` — verify no route change is needed (`apps/api/src/routes/tickets/tickets.ts:390`).

- [ ] **Step 4: Run — expect PASS** (both suites, plus `routes/tickets/tickets.test.ts`).
- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/tickets.ts packages/shared/src/validators/tickets.test.ts apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.test.ts
git commit -m "feat(tickets): per-ticket SLA override via PATCH (chain link 1)"
```

---

## Task 8: Queue filter, triage sort, stats — **Codex (high)**

**Files:**
- Modify: `packages/shared/src/validators/tickets.ts` (`listTicketsQuerySchema` :66-78)
- Modify: `apps/api/src/routes/tickets/tickets.ts` (stats :158-202, list :205-297)
- Test: `packages/shared/src/validators/tickets.test.ts`, `apps/api/src/routes/tickets/tickets.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// validators: slaState enum
it('listTicketsQuerySchema accepts slaState values', () => {
  for (const v of ['ok', 'at_risk', 'breached', 'breaching']) {
    expect(listTicketsQuerySchema.parse({ slaState: v }).slaState).toBe(v);
  }
  expect(() => listTicketsQuerySchema.parse({ slaState: 'nope' })).toThrow();
});

// routes (existing Drizzle-mock style): assert the WHERE/ORDER SQL produced
it('GET /tickets?slaState=breached filters on sla_breached_at IS NOT NULL', async () => {});
it('GET /tickets?slaState=breaching ORs breached with the at-risk expression', async () => {});
it('triage sort orders breached first, then at-risk, then priority', async () => {});
it('GET /tickets projects responseSlaMinutes, slaPausedAt, slaPausedMinutes, slaBreachReason', async () => {});
it('GET /tickets/stats returns atRisk alongside breached', async () => {});
```

- [ ] **Step 2: Run — expect FAIL:**

```bash
cd apps/api && npx vitest run src/routes/tickets/tickets.test.ts --pool=forks --poolOptions.forks.singleFork=true
```

- [ ] **Step 3: Implement.**
  - Validator — add to `listTicketsQuerySchema`:

```ts
  slaState: z.enum(['ok', 'at_risk', 'breached', 'breaching']).optional(),
```

  - Routes — near the other module-level helpers in `tickets.ts`, define the SQL twins of `ticketSla.ts` (keep this comment):

```ts
// SQL twins of services/ticketSla.ts rules — change them together.
// Active elapsed = now - created_at - paused; at-risk at 80% of the tighter target (D7).
const SLA_BREACHED = sql`${tickets.slaBreachedAt} IS NOT NULL`;
const SLA_AT_RISK = sql`(
  ${tickets.slaBreachedAt} IS NULL
  AND ${tickets.status} IN ('new', 'open')
  AND ${tickets.slaPausedAt} IS NULL
  AND (
    (${tickets.firstResponseAt} IS NULL AND ${tickets.responseSlaMinutes} IS NOT NULL
      AND now() >= ${tickets.createdAt}
        + COALESCE(${tickets.slaPausedMinutes}, 0) * interval '1 minute'
        + ${tickets.responseSlaMinutes} * interval '1 minute' * 0.8)
    OR (${tickets.resolutionSlaMinutes} IS NOT NULL
      AND now() >= ${tickets.createdAt}
        + COALESCE(${tickets.slaPausedMinutes}, 0) * interval '1 minute'
        + ${tickets.resolutionSlaMinutes} * interval '1 minute' * 0.8)
  )
)`;
```

  In the list handler, after the priority filter:

```ts
    if (q.slaState === 'breached') conditions.push(SLA_BREACHED);
    else if (q.slaState === 'at_risk') conditions.push(SLA_AT_RISK);
    else if (q.slaState === 'breaching') conditions.push(sql`(${SLA_BREACHED} OR ${SLA_AT_RISK})`);
    else if (q.slaState === 'ok') conditions.push(sql`(NOT ${SLA_BREACHED} AND NOT ${SLA_AT_RISK})`);
```

  Triage sort (replace the existing triage branch only):

```ts
      : [desc(SLA_BREACHED), desc(SLA_AT_RISK), PRIORITY_ORDER, asc(tickets.createdAt), asc(tickets.id)]; // triage: breaches surface first
```

  (If `desc()` rejects raw SQL conditions in this Drizzle version, use `` sql`${SLA_BREACHED} DESC` `` / `` sql`${SLA_AT_RISK} DESC` ``.)

  Projection — add to the list `select({...})`:

```ts
        responseSlaMinutes: tickets.responseSlaMinutes,
        slaPausedAt: tickets.slaPausedAt,
        slaPausedMinutes: tickets.slaPausedMinutes,
        slaBreachReason: tickets.slaBreachReason,
```

  Stats — after the existing grouped query, add one aggregate and include `atRisk` in the response:

```ts
    const slaRows = await db
      .select({ atRisk: sql<number>`count(*) FILTER (WHERE ${SLA_AT_RISK})` })
      .from(tickets)
      .where(whereCondition);
    const atRisk = Number(slaRows[0]?.atRisk ?? 0);
    return c.json({ data: { open, unassigned, mine, breached, atRisk } });
```

- [ ] **Step 4: Run — expect PASS** (routes + validators suites).
- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/tickets.ts packages/shared/src/validators/tickets.test.ts apps/api/src/routes/tickets/tickets.ts apps/api/src/routes/tickets/tickets.test.ts
git commit -m "feat(tickets): SLA-state queue filter, SLA-aware triage sort, at-risk stat"
```

---

## Task 9: SLA index migration — **Codex (low)**

**Files:**
- Create: `apps/api/migrations/2026-06-12-a-ticket-sla-indexes.sql` (re-date to the execution date; keep the `-a-` infix only if another ticket migration lands the same day)

- [ ] **Step 1: Write the migration** (idempotent; no inner BEGIN/COMMIT; partial indexes sized to the two hot access paths — the sweep and the breached/at-risk filters):

```sql
-- Phase 2 SLA engine (spec §8a): index-backed sweep + queue SLA filters.
-- Sweep scans active, unpaused tickets ordered by created_at.
CREATE INDEX IF NOT EXISTS tickets_sla_sweep_idx
  ON tickets (created_at)
  WHERE status IN ('new', 'open') AND sla_paused_at IS NULL;

-- Breached-queue filter + stats count.
CREATE INDEX IF NOT EXISTS tickets_sla_breached_idx
  ON tickets (partner_id, status)
  WHERE sla_breached_at IS NOT NULL;
```

- [ ] **Step 2: Apply locally and verify idempotency**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
# restart the API (autoMigrate applies it), or apply manually twice — second run must be a no-op
docker exec -i breeze-postgres psql -U breeze -d breeze -c "\di tickets_sla*"
```

Expected: both indexes listed; re-apply produces no errors.

- [ ] **Step 3: Drift check**

```bash
pnpm db:check-drift
```

If drift is flagged for the new indexes, add the matching extras block to the `tickets` pgTable in `apps/api/src/db/schema/portal.ts` (note: the Phase-1 ticket indexes exist in SQL without schema extras, so no drift is the likely outcome — match whatever the check demands).

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-06-12-a-ticket-sla-indexes.sql
git commit -m "feat(tickets): partial indexes for SLA sweep and breached-queue filters"
```

---

## Task 10: Web — pause-aware `slaState()` + paused chip — **Claude (in-session)**

**Files:**
- Modify: `apps/web/src/components/tickets/ticketConfig.ts` (`TicketSummary` :5-25, `slaState` :77-98)
- Modify: `apps/web/src/components/tickets/SlaChip.tsx`
- Test: `apps/web/src/components/tickets/ticketConfig.test.ts` (or the file's existing test name), `SlaChip.test.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
const base = { status: 'open' as const, slaBreachedAt: null, createdAt: new Date(Date.now() - 60 * 60_000).toISOString(), firstResponseAt: null };

it('uses the response target when first response is outstanding', () => {
  // 60m elapsed, response target 90m (66% — ok), resolution 480m
  const s = slaState({ ...base, responseSlaMinutes: 90, resolutionSlaMinutes: 480 });
  expect(s.kind).toBe('ok');
  // 60m elapsed, response target 70m (86% — at-risk)
  expect(slaState({ ...base, responseSlaMinutes: 70, resolutionSlaMinutes: 480 }).kind).toBe('at-risk');
});

it('ignores the response target once firstResponseAt is set', () => {
  const s = slaState({ ...base, firstResponseAt: new Date().toISOString(), responseSlaMinutes: 10, resolutionSlaMinutes: 480 });
  expect(s.kind).toBe('ok');
});

it('freezes the clock while paused and reports paused', () => {
  const s = slaState({ ...base, slaPausedAt: new Date().toISOString(), resolutionSlaMinutes: 90, slaPausedMinutes: 0 });
  expect(s.kind).toBe('paused');
});

it('subtracts accumulated pause minutes', () => {
  // 60m wall elapsed, 30m paused → 30m active; target 90m → ok with 60m left
  const s = slaState({ ...base, resolutionSlaMinutes: 90, slaPausedMinutes: 30 });
  expect(s.kind).toBe('ok');
  if (s.kind === 'ok') expect(Math.round(s.minutesLeft)).toBe(60);
});
```

- [ ] **Step 2: Run — expect FAIL:**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/tickets/ticketConfig.test.ts src/components/tickets/SlaChip.test.tsx
```

- [ ] **Step 3: Implement.**
  - `TicketSummary`: add `responseSlaMinutes?: number | null; slaPausedAt?: string | null; slaPausedMinutes?: number | null; slaBreachReason?: string | null;` (the list endpoint now projects them — Task 8).
  - `SlaState`: add `| { kind: 'paused'; minutesLeft: number }`.
  - Rewrite `slaState`:

```ts
// Client twin of the server SLA rules (services/ticketSla.ts) — change together.
export function slaState(
  t: Pick<TicketSummary, 'slaBreachedAt' | 'createdAt' | 'status' | 'firstResponseAt'> &
     { resolutionSlaMinutes?: number | null; responseSlaMinutes?: number | null; slaPausedAt?: string | null; slaPausedMinutes?: number | null },
  now: Date = new Date()
): SlaState {
  if (t.status === 'resolved' || t.status === 'closed') return { kind: 'none' };
  if (t.slaBreachedAt) {
    return { kind: 'breached', minutesAgo: (now.getTime() - new Date(t.slaBreachedAt).getTime()) / 60_000 };
  }
  const targets: number[] = [];
  if (t.responseSlaMinutes && !t.firstResponseAt) targets.push(t.responseSlaMinutes);
  if (t.resolutionSlaMinutes) targets.push(t.resolutionSlaMinutes);
  if (targets.length === 0) return { kind: 'none' };

  // Both targets share the createdAt clock, so the smallest target is the most urgent.
  const target = Math.min(...targets);
  const clockEnd = t.slaPausedAt ? new Date(t.slaPausedAt) : now; // frozen while paused
  const activeElapsed = (clockEnd.getTime() - new Date(t.createdAt).getTime()) / 60_000 - (t.slaPausedMinutes ?? 0);
  const left = target - activeElapsed;
  if (t.slaPausedAt) return { kind: 'paused', minutesLeft: Math.max(0, left) };
  if (left <= 0) return { kind: 'breached', minutesAgo: -left };
  if (activeElapsed >= 0.8 * target) return { kind: 'at-risk', minutesLeft: left };
  return { kind: 'ok', minutesLeft: left };
}
```

  - `SlaChip.tsx`: add a `paused` case rendering a muted chip (`Paused · {formatRelative(minutesLeft)} left`), consistent with the existing per-state styling; keep `data-testid` conventions.

- [ ] **Step 4: Run — expect PASS.** Also run `TicketsPage.test.tsx` / `TicketQueueList.test.tsx` (they consume `slaState`).
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tickets/ticketConfig.ts apps/web/src/components/tickets/SlaChip.tsx apps/web/src/components/tickets/*.test.ts*
git commit -m "feat(tickets/web): pause- and response-aware SLA state with paused chip"
```

---

## Task 11: Web — server-driven breaching tab + countdown — **Claude (in-session)**

**Files:**
- Modify: `apps/web/src/components/tickets/TicketsPage.tsx` (`tabQuery` :41-48, client breaching filter :191-193, stats badges)
- Test: `apps/web/src/components/tickets/TicketsPage.test.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
it('breaching tab requests slaState=breaching from the API', async () => {
  // select the breaching tab; assert the fetched URL contains 'slaState=breaching'
  // and does NOT client-filter the returned rows
});
it('breaching tab badge shows breached + atRisk from /tickets/stats', async () => {});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.**
  - In `tabQuery`, make the `breaching` tab contribute `{ statusGroup: 'open', slaState: 'breaching' }` to the request params and delete the client-side `slaState()` filter at :191-193 (rows now arrive pre-filtered; keep `slaState()` for chip rendering only).
  - Badge: the breaching tab count = `stats.breached + stats.atRisk` from the extended `/tickets/stats` payload (Task 8).
  - The queue's SLA column already renders `SlaChip`; confirm it passes the full ticket row (new fields flow through from the API projection) — adjust the row mapping if it cherry-picks fields.

- [ ] **Step 4: Run — expect PASS:**

```bash
cd apps/web && npx vitest run src/components/tickets/TicketsPage.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tickets/TicketsPage.tsx apps/web/src/components/tickets/TicketsPage.test.tsx
git commit -m "feat(tickets/web): server-driven breaching tab with at-risk-aware badge"
```

---

## Task 12: Web — SLA timers rail — **Claude (in-session)**

**Files:**
- Create: `apps/web/src/components/tickets/SlaTimers.tsx`
- Create: `apps/web/src/components/tickets/SlaTimers.test.tsx`
- Modify: `apps/web/src/components/tickets/TicketWorkbench.tsx` (right rail)

- [ ] **Step 1: Write the failing tests**

```tsx
it('renders both timers with countdowns', () => {
  render(<SlaTimers ticket={mkTicket({ responseSlaMinutes: 60, resolutionSlaMinutes: 240 })} />);
  expect(screen.getByTestId('sla-timer-response')).toHaveTextContent(/left/);
  expect(screen.getByTestId('sla-timer-resolution')).toHaveTextContent(/left/);
});
it('shows response as met once firstResponseAt is set', () => {
  // expect sla-timer-response to contain 'Met'
});
it('shows breached targets from slaBreachReason', () => {
  // slaBreachReason 'response' → response timer shows 'Breached'
});
it('shows a paused note while slaPausedAt is set', () => {
  expect(screen.getByTestId('sla-timers-paused')).toBeInTheDocument();
});
it('renders nothing when the ticket has no SLA targets', () => {
  expect(screen.queryByTestId('sla-timers')).toBeNull();
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found).

- [ ] **Step 3: Implement**

```tsx
// apps/web/src/components/tickets/SlaTimers.tsx
import type { TicketDetail } from './ticketConfig';
import { formatRelative } from './ticketConfig';

type TimerState =
  | { kind: 'met'; at: string }
  | { kind: 'breached' }
  | { kind: 'counting'; minutesLeft: number }
  | { kind: 'paused'; minutesLeft: number };

function timerState(
  target: number,
  metAt: string | null,
  breached: boolean,
  createdAt: string,
  slaPausedAt: string | null | undefined,
  slaPausedMinutes: number | null | undefined,
  now: Date
): TimerState {
  if (metAt) return { kind: 'met', at: metAt };
  if (breached) return { kind: 'breached' };
  const clockEnd = slaPausedAt ? new Date(slaPausedAt) : now;
  const activeElapsed = (clockEnd.getTime() - new Date(createdAt).getTime()) / 60_000 - (slaPausedMinutes ?? 0);
  const minutesLeft = Math.max(0, target - activeElapsed);
  return slaPausedAt ? { kind: 'paused', minutesLeft } : { kind: 'counting', minutesLeft };
}

function TimerRow({ label, state, testId }: { label: string; state: TimerState; testId: string }) {
  const text =
    state.kind === 'met' ? 'Met'
    : state.kind === 'breached' ? 'Breached'
    : state.kind === 'paused' ? `Paused · ${formatRelative(state.minutesLeft)} left`
    : `${formatRelative(state.minutesLeft)} left`;
  const tone =
    state.kind === 'breached' ? 'text-red-700 dark:text-red-400'
    : state.kind === 'met' ? 'text-success'
    : 'text-muted-foreground';
  return (
    <div className="flex items-center justify-between text-sm" data-testid={testId}>
      <span className="text-muted-foreground">{label}</span>
      <span className={tone}>{text}</span>
    </div>
  );
}

export function SlaTimers({ ticket, now = new Date() }: { ticket: TicketDetail; now?: Date }) {
  const breached = new Set((ticket.slaBreachReason ?? '').split(',').map((s) => s.trim()));
  const hasResponse = !!ticket.responseSlaMinutes;
  const hasResolution = !!ticket.resolutionSlaMinutes;
  if (!hasResponse && !hasResolution) return null;
  const terminal = ticket.status === 'resolved' || ticket.status === 'closed';
  return (
    <div className="space-y-2" data-testid="sla-timers">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">SLA</h3>
      {hasResponse && (
        <TimerRow label="First response" testId="sla-timer-response"
          state={timerState(ticket.responseSlaMinutes!, ticket.firstResponseAt, breached.has('response'),
            ticket.createdAt, ticket.slaPausedAt, ticket.slaPausedMinutes, now)} />
      )}
      {hasResolution && (
        <TimerRow label="Resolution" testId="sla-timer-resolution"
          state={timerState(ticket.resolutionSlaMinutes!, terminal ? (ticket.updatedAt ?? null) : null,
            breached.has('resolution'), ticket.createdAt, ticket.slaPausedAt, ticket.slaPausedMinutes, now)} />
      )}
      {ticket.slaPausedAt && !terminal && (
        <p className="text-xs text-muted-foreground" data-testid="sla-timers-paused">
          Clock paused while the ticket is {ticket.status === 'on_hold' ? 'on hold' : 'pending'}.
        </p>
      )}
    </div>
  );
}
```

(Resolution "met" display: the API doesn't project `resolvedAt` in `TicketDetail` today — if it does after Task 8's projection pass, prefer `ticket.resolvedAt`; otherwise terminal-status + `updatedAt` is the honest approximation. Check the GET `/:id` projection while wiring and use `resolvedAt` if present.)

Mount in `TicketWorkbench.tsx`'s right rail (with the assignment/priority controls): `<SlaTimers ticket={ticket} />`.

- [ ] **Step 4: Run — expect PASS:**

```bash
cd apps/web && npx vitest run src/components/tickets/SlaTimers.test.tsx src/components/tickets/TicketWorkbench.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tickets/SlaTimers.tsx apps/web/src/components/tickets/SlaTimers.test.tsx apps/web/src/components/tickets/TicketWorkbench.tsx
git commit -m "feat(tickets/web): SLA timers rail on ticket detail"
```

---

## Task 13: Verification + PR

- [ ] **Step 1: Affected-file test pass** (single-fork, per the known parallel-flakiness note):

```bash
cd apps/api && npx vitest run \
  src/services/ticketSla.test.ts src/services/ticketService.test.ts src/services/ticketEvents.test.ts \
  src/services/ticketEventsContract.test.ts src/services/aiToolsTicketing.test.ts \
  src/routes/tickets/tickets.test.ts src/routes/tickets/bulk.test.ts src/routes/portal/tickets.test.ts \
  src/jobs/ticketSlaWorker.test.ts src/jobs/ticketNotifyWorker.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true
cd ../../packages/shared && npx vitest run src/validators/tickets.test.ts
cd ../../apps/web && npx vitest run src/components/tickets/
```

- [ ] **Step 2: Type check:** `cd apps/api && npx tsc --noEmit` (pre-existing errors in `agents.test.ts`/`apiKeyAuth.test.ts` are known — anything else is yours).

- [ ] **Step 3: Live smoke** (dev stack): create an urgent ticket with a category whose response SLA is 1 minute, post no comment, wait ~2 minutes → `sla_breached_at` stamped, in-app notification for the assignee, breaching tab shows the ticket, SLA timers show "Breached".

- [ ] **Step 4: PR.** Two-PR split: **PR A** = Tasks 1-9 (API engine), **PR B** = Tasks 10-12 (web UI, lands after A). Use `superpowers:requesting-code-review` before each; merge via `gh pr merge --squash --admin` when green.

---

## Self-review notes (spec coverage)

Phase 2 checklist from §8 → tasks: resolution chain (T1+T2+T7), monitor job (T5+T9), pause logic (T3), queue countdown (T10+T11), breaching-soon tab (T11), breach notifications (T4+T5+T6), SLA filters/stats/triage (T8), SLA timers rail (T12), §8a index-backed queries (T9). Deferred with rationale: dashboard widget, business hours, escalations, at-risk notifications, e2e (see "Out of scope").
