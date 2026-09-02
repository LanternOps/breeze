---
tracking_issue: LanternOps/breeze#3821
wave: W09 (#4085)
---

# Wave 3.5c — Durable Event Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flag-gated at-least-once event delivery — BullMQ ingress plus independent per-subscriber delivery jobs with durable Postgres receipts — proven inside the existing all-in-one process, replacing nothing by default.

**Architecture:** `EventBus.publish()` gains a mode-gated enqueue of one `route-event` job whose data snapshots the publisher's full routing plan (event + matched/queue subscriber ids). A router worker expands the plan verbatim into per-subscriber `deliver-event` jobs; each delivery claims a durable receipt row `(event_id, subscriber_id)`, runs the (now-throwing) handler, and marks the receipt. Local delivery keeps today's swallow semantics via a wrapper; for each subscriber, delivery is exactly one of local or queue, decided at publish time from the snapshot. Shadow mode mirrors the plan into receipts and compares against local execution without changing behavior.

**Tech Stack:** Hono/TypeScript, BullMQ (`createInstrumentedQueue`, `attachWorkerObservability`), Drizzle + hand-written SQL migrations, Vitest (unit + real-PG/Redis integration).

**Design authority:** Issue #4085 (decisions marked "do not relitigate") + advisor quorum 2026-08-26 (Claude position, codex `xhigh` review; codex amendments accepted: Postgres receipts over Redis-TTL receipts — automation dedupe is only the last-200-completed BullMQ jobs, so post-retention redelivery creates fresh automation runs; route jobs snapshot the publisher's plan, the router never recomputes; the `alert_notifications` constraint ships with a claim-style state machine, not a bare index).

## Global Constraints

- Migration filenames MUST sort after the newest committed migration. At plan time that is `2026-09-11-d-webhook-delivery-recovery.sql`; the plan uses `2026-09-11-e/f/g-`. **Verify at implementation time** (`ls apps/api/migrations/*.sql | sort | tail -1`) and rename to sort after whatever is newest. Never a new `2026-08-06-*`.
- Migrations: idempotent (`IF NOT EXISTS` / `DO $$`), no inner `BEGIN;`/`COMMIT;`, cleanup DELETEs report row counts via `GET DIAGNOSTICS n = ROW_COUNT; RAISE WARNING`.
- BullMQ jobIds are hyphen-only — a `:` in a custom jobId is rejected (`apps/api/src/jobs/aiAgentRunner.ts:54`).
- Every Redis/BullMQ enqueue from a code path that may hold a DB context runs via `runOutsideDbContext` (#1105). Use `createInstrumentedQueue` (`apps/api/src/services/bullmqQueue.ts:41`), never bare `new Queue`.
- New env vars land in `apps/api/src/config/env.ts` + `apps/api/src/config/validate.ts` + `.env.example` + `docker-compose.yml` `api.environment` + `deploy/docker-compose.prod.yml` in the SAME task (`envComposeParity.test.ts` enforces).
- New integration test files MUST be added to the explicit `include` list in `apps/api/vitest.integration.config.ts` (line ~11) — a misplaced file is collected by ZERO CI jobs and reads green.
- Run single test files as `cd apps/api && npx vitest run <path>` (never `pnpm --filter ... test -- --run <path>`; the `--` runs the whole suite in watch mode). Integration: `npx vitest run --config vitest.integration.config.ts <path>` with real PG+Redis.
- `pnpm db:check-drift` must stay clean: every migration column/index needs a matching Drizzle declaration.
- Do NOT relitigate (issue #4085 + prior quorum): no `startConsuming()` activation; BullMQ over Redis Streams consumer groups; retry unit is per-subscriber, never the whole fan-out; redelivery replays the ORIGINAL `event.id`; `publishUserEvent` stays out of the fan-out; this is NOT a transactional outbox (crash between XADD and `queue.add` still loses dispatch — documented accepted risk).
- Commit after every task (checkpoint commits; context loss must be cheap).

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/eventSubscriberIds.ts` (new) | Leaf module: the canonical subscriber-id list. No imports — safe for `config/validate.ts`. |
| `apps/api/src/services/eventSubscriberRegistry.ts` (new) | Registry of durable subscribers; routing plan computation (`partitionSubscribersForEvent`). |
| `apps/api/src/services/eventSubscribers.ts` (new) | Synchronous boot-time registration of the five production subscribers (phase before worker init). |
| `apps/api/src/services/eventDispatchQueue.ts` (new) | The `event-dispatch` queue singleton; `enqueueRouteEvent()`; shadow local-side recording helpers. |
| `apps/api/src/jobs/eventDispatchWorker.ts` (new) | Router + delivery worker; receipt CAS lifecycle; retention sweep; shadow comparison job. |
| `apps/api/src/db/schema/eventDispatch.ts` (new) | `event_delivery_receipts` Drizzle schema. |
| `apps/api/src/services/eventBus.ts` (modify) | Mode-gated enqueue in `publish()`; registry-aware `invokeLocalHandlers`; DELETE the dead consumer-group/DLQ half. |
| `apps/api/src/config/env.ts` / `validate.ts` (modify) | `EVENT_DISPATCH_MODE`, `EVENT_DISPATCH_QUEUE_SUBSCRIBERS`. |
| Five subscriber modules (modify) | Registry migration + throwing handler contract. |
| `apps/api/src/services/notificationDispatcher.ts` (modify) | Send-identity state machine, status guards, stable jobIds, failed-job retry. |
| `apps/api/src/services/policyAlertBridge.ts` (modify) | Reconcile-from-persisted-truth guard. |
| `apps/api/src/index.ts` (modify) | Sync registration phase; dispatch worker starts after `Promise.allSettled`. |
| Migrations `2026-09-11-e/f/g-*.sql` (new) | Receipts table; alert_notifications send identity; drop `event_bus_events`. |

Stable subscriber ids (never rename once shipped — they key durable receipts):
`webhook-delivery` · `automation-worker` · `policy-alert-bridge` · `notification-dispatcher` · `dns-threat-alerts`. (`plugins.ts` PluginEventBridge is NOT registered in production today — `initPluginEventBridge()` has no production caller — and stays out of scope, as in 3.5a.)

---

### Task 1: Flags — `EVENT_DISPATCH_MODE` + `EVENT_DISPATCH_QUEUE_SUBSCRIBERS`

**Files:**
- Create: `apps/api/src/services/eventSubscriberIds.ts`
- Modify: `apps/api/src/config/env.ts` (append near `abuseSignalsEnabled`, ~line 180)
- Modify: `apps/api/src/config/validate.ts` (schema entries + `superRefine`)
- Modify: `.env.example`, `docker-compose.yml` (api `environment:`), `deploy/docker-compose.prod.yml` (api `environment:`)
- Test: `apps/api/src/config/env.eventDispatch.test.ts`

**Interfaces:**
- Produces: `EVENT_SUBSCRIBER_IDS: readonly SubscriberId[]`, `type SubscriberId`, `eventDispatchMode(): 'off'|'shadow'|'enforce'`, `eventDispatchQueueSubscribers(): ReadonlySet<SubscriberId>`.

- [ ] **Step 1: Write the leaf id module** (no test needed — it is a const):

```ts
// apps/api/src/services/eventSubscriberIds.ts
// Canonical ids for durable event subscribers (wave 3.5c, #4085). These key
// event_delivery_receipts rows and the EVENT_DISPATCH_QUEUE_SUBSCRIBERS flag —
// renaming one orphans receipts and silently drops it from the queue cohort.
export const EVENT_SUBSCRIBER_IDS = [
  'automation-worker',
  'dns-threat-alerts',
  'notification-dispatcher',
  'policy-alert-bridge',
  'webhook-delivery',
] as const;

export type SubscriberId = (typeof EVENT_SUBSCRIBER_IDS)[number];

export function isSubscriberId(value: string): value is SubscriberId {
  return (EVENT_SUBSCRIBER_IDS as readonly string[]).includes(value);
}
```

- [ ] **Step 2: Write the failing flag tests**

```ts
// apps/api/src/config/env.eventDispatch.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('eventDispatchMode', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('defaults to off when unset', async () => {
    vi.stubEnv('EVENT_DISPATCH_MODE', '');
    const { eventDispatchMode } = await import('./env');
    expect(eventDispatchMode()).toBe('off');
  });

  it('parses shadow and enforce', async () => {
    const { eventDispatchMode } = await import('./env');
    vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
    expect(eventDispatchMode()).toBe('shadow');
    vi.stubEnv('EVENT_DISPATCH_MODE', 'enforce');
    expect(eventDispatchMode()).toBe('enforce');
  });

  it('falls back to off WITH a warning on an unrecognized value (never silently enforce)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('EVENT_DISPATCH_MODE', 'enforced'); // typo
    const { eventDispatchMode } = await import('./env');
    expect(eventDispatchMode()).toBe('off');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EVENT_DISPATCH_MODE'));
  });

  it('parses the queue-subscriber csv, trims, drops empties', async () => {
    vi.stubEnv('EVENT_DISPATCH_QUEUE_SUBSCRIBERS', ' webhook-delivery, notification-dispatcher ,');
    const { eventDispatchQueueSubscribers } = await import('./env');
    expect([...eventDispatchQueueSubscribers()].sort()).toEqual([
      'notification-dispatcher', 'webhook-delivery',
    ]);
  });

  it('ignores unknown ids in the csv with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('EVENT_DISPATCH_QUEUE_SUBSCRIBERS', 'webhook-delivery,not-a-subscriber');
    const { eventDispatchQueueSubscribers } = await import('./env');
    expect([...eventDispatchQueueSubscribers()]).toEqual(['webhook-delivery']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not-a-subscriber'));
  });
});
```

- [ ] **Step 3: Run to verify failure** — `cd apps/api && npx vitest run src/config/env.eventDispatch.test.ts` → FAIL (`eventDispatchMode` not exported).

- [ ] **Step 4: Implement in `config/env.ts`** (read-at-call-time functions, tri-state per `abuseSignalsEnabled`):

```ts
import { EVENT_SUBSCRIBER_IDS, isSubscriberId, type SubscriberId } from '../services/eventSubscriberIds';

export type EventDispatchMode = 'off' | 'shadow' | 'enforce';

/** Wave 3.5c (#4085). off = today's in-process delivery only. shadow = mirror
 * routing plans into receipts, execute nothing via the queue. enforce = the
 * subscribers listed in EVENT_DISPATCH_QUEUE_SUBSCRIBERS deliver via BullMQ
 * ONLY (skipped locally); everyone else stays local. Unrecognized values fall
 * back to 'off' with a warning — a typo must never silently change delivery. */
export function eventDispatchMode(): EventDispatchMode {
  const raw = (process.env.EVENT_DISPATCH_MODE ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'off') return 'off';
  if (raw === 'shadow' || raw === 'enforce') return raw;
  console.warn(`[config] EVENT_DISPATCH_MODE="${raw}" is not off|shadow|enforce — treating as off`);
  return 'off';
}

export function eventDispatchQueueSubscribers(): ReadonlySet<SubscriberId> {
  const raw = (process.env.EVENT_DISPATCH_QUEUE_SUBSCRIBERS ?? '').trim();
  const out = new Set<SubscriberId>();
  if (raw === '') return out;
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    if (isSubscriberId(part)) out.add(part);
    else console.warn(`[config] EVENT_DISPATCH_QUEUE_SUBSCRIBERS contains unknown id "${part}" (known: ${EVENT_SUBSCRIBER_IDS.join(', ')}) — ignoring`);
  }
  return out;
}
```

- [ ] **Step 5: Run tests** → PASS.

- [ ] **Step 6: validate.ts + compose wiring.** In `config/validate.ts` add both vars to the Zod schema as `z.string().optional()` and a `superRefine` block: `EVENT_DISPATCH_MODE` must be one of `''|off|shadow|enforce` (hard error — boot refusal beats a silent fallback in prod, mirroring the abuse-signals vocabulary check at validate.ts:1630); every csv entry of `EVENT_DISPATCH_QUEUE_SUBSCRIBERS` must satisfy `isSubscriberId` (hard error); `enforce` with an empty csv is a warning-level `console.warn`, not an error. Add to `.env.example` (commented, with the three-mode doc) and to the `api` service `environment:` blocks of BOTH compose files as `EVENT_DISPATCH_MODE: ${EVENT_DISPATCH_MODE:-off}` / `EVENT_DISPATCH_QUEUE_SUBSCRIBERS: ${EVENT_DISPATCH_QUEUE_SUBSCRIBERS:-}`.

- [ ] **Step 7: Run the parity + validate tests** — `cd apps/api && npx vitest run src/config/envComposeParity.test.ts src/config/env.eventDispatch.test.ts` → PASS.

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat(api): event-dispatch mode flags (wave 3.5c, #4085)"`

---

### Task 2: Subscriber registry + registry-aware local delivery

**Files:**
- Create: `apps/api/src/services/eventSubscriberRegistry.ts`
- Modify: `apps/api/src/services/eventBus.ts` (`invokeLocalHandlers`, ~L373)
- Test: `apps/api/src/services/eventSubscriberRegistry.test.ts`, extend `apps/api/src/services/eventBus.test.ts`

**Interfaces:**
- Consumes: `SubscriberId` (Task 1), `EventType`/`BreezeEvent` from `eventBus.ts`, `eventDispatchMode`/`eventDispatchQueueSubscribers` (Task 1).
- Produces:
```ts
export interface DurableEventSubscriber {
  id: SubscriberId;
  eventTypes: readonly EventType[] | '*';
  /** MUST throw on failure (queue mode relies on it). Local delivery wraps. */
  handler: (event: BreezeEvent) => Promise<void>;
  /** Per-subscriber BullMQ retry policy for deliver-event jobs. */
  retry?: { attempts: number; backoffMs: number };
}
export function registerEventSubscriber(sub: DurableEventSubscriber): void; // throws on duplicate id
export function getRegisteredSubscribers(): readonly DurableEventSubscriber[];
export function subscribersMatching(type: EventType): DurableEventSubscriber[]; // '*' or exact, sorted by id
export function partitionSubscribersForEvent(type: EventType): {
  matched: SubscriberId[]; local: DurableEventSubscriber[]; queue: DurableEventSubscriber[];
}; // queue = matched ∩ eventDispatchQueueSubscribers() when mode==='enforce', else empty
export function getSubscriberById(id: SubscriberId): DurableEventSubscriber | undefined;
export function _resetEventSubscriberRegistryForTests(): void;
```

- [ ] **Step 1: Write failing registry tests** — cover: duplicate id registration throws; `subscribersMatching` returns `'*'` subscribers for every type plus exact matches, sorted by id (deterministic — replaces today's unstable `handlerIndex` ordering); `partitionSubscribersForEvent` returns everything in `local` when mode is `off`/`shadow`; in `enforce` with `EVENT_DISPATCH_QUEUE_SUBSCRIBERS=webhook-delivery`, a matched `webhook-delivery` lands in `queue` and NOT in `local` (assert disjointness: `local ∩ queue = ∅` and `local ∪ queue = matched`); an id in the csv that does not match the event type appears in neither. Use `vi.stubEnv` + `_resetEventSubscriberRegistryForTests`.

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement the registry.** Plain `Map<SubscriberId, DurableEventSubscriber>`; `registerEventSubscriber` throws `new Error(\`duplicate event subscriber id: ${sub.id}\`)` on re-registration; sorting via `localeCompare` on id.

- [ ] **Step 4: Make `invokeLocalHandlers` registry-aware.** In `eventBus.ts`, after the legacy `handlers` map iteration (kept as-is for tests/back-compat), iterate `partitionSubscribersForEvent(event.type).local` sequentially. Wrap each in the local-delivery wrapper that preserves today's semantics AND closes the stdout-only gap:

```ts
// inside invokeLocalHandlers, after the legacy loop
const { local } = partitionSubscribersForEvent(event.type);
for (const sub of local) {
  try {
    await sub.handler(event);
  } catch (error) {
    // Local delivery keeps wave-3d semantics: a buggy subscriber must not
    // break the publish path (#820). Queue delivery (eventDispatchWorker)
    // deliberately does NOT catch — the throw drives BullMQ retries.
    console.error('[EventBus] local-handler-failed', JSON.stringify({
      errorId: 'EVENT_BUS_LOCAL_HANDLER_FAILED',
      eventId: event.id, eventType: event.type, orgId: event.orgId,
      source: event.source, subscriberId: sub.id,
      error: serializeError(error),
    }));
    captureException(error); // NEW — five of six subscribers were stdout-only
  }
}
```
Keep the existing `serializeError`-equivalent inline shape already used at eventBus.ts:397-415; import `captureException` from `./sentry`. The structured log gains `subscriberId` (stable) — keep `handlerIndex` only for the legacy loop.

- [ ] **Step 5: Extend eventBus tests** — new cases: a registered local subscriber receives published events; a queue-partitioned subscriber (enforce + csv) is NOT invoked locally; a throwing registered subscriber logs `EVENT_BUS_LOCAL_HANDLER_FAILED` with its `subscriberId` and does not affect later subscribers. Run `npx vitest run src/services/eventBus.test.ts src/services/eventSubscriberRegistry.test.ts` → PASS.

- [ ] **Step 6: Commit** — `feat(api): durable event subscriber registry with registry-aware local delivery`

---

### Task 3: Migrate the five subscribers to the registry with a throwing contract

**Files:**
- Create: `apps/api/src/services/eventSubscribers.ts`
- Modify: `apps/api/src/workers/webhookDelivery.ts` (~:630-726), `apps/api/src/jobs/automationWorker.ts` (~:1034-1052), `apps/api/src/services/policyAlertBridge.ts` (~:237-266), `apps/api/src/services/notificationDispatcher.ts` (~:1150-1188), `apps/api/src/services/dnsThreatAlerts.ts` (~:132-160), `apps/api/src/index.ts`
- Test: `apps/api/src/services/eventSubscribers.contract.test.ts` + each module's existing test file

**Interfaces:**
- Produces: `registerAllEventSubscribers(deps: { getWebhooksForEvent: (orgId: string, eventType: string) => Promise<WebhookConfig[]>; createDeliveryRecord?: CreateWebhookDeliveryRecord }): void` — synchronous, idempotent-guarded, called from `index.ts` BEFORE `initializeWorkers()`'s `Promise.allSettled` (codex Q3 hole #2: the dispatch worker must never start before the full registry is installed).
- Handler contract change: each module exports a named `handleXxxEvent(event: BreezeEvent): Promise<void>` that THROWS on failure. The old `subscribe()` calls are deleted.

Per-module changes (each: write/adjust the failing test first, then implement, then run that module's tests):

- [ ] **Step 1: `webhookDelivery.ts`** — export `handleWebhookFanoutEvent(event)`: body of the current `'*'` subscriber with two contract changes (codex D2 amendment): (a) the lookup-failure branch (currently catch → log `WEBHOOK_EVENT_ROUTING_FAILED` → return — the one unrecoverable drop #4098's sweep cannot see) now RETHROWS after logging, so queue mode retries it; (b) the per-webhook loop keeps its per-iteration try/catch (one webhook must not abort the rest) but collects failures and, after the loop, throws an aggregate when any occurred:

```ts
const failures: Array<{ webhookId: string; error: unknown }> = [];
for (const webhook of webhooks) {
  try { /* existing record+queue body */ } catch (error) { /* existing captureException + log */ failures.push({ webhookId: webhook.id, error }); }
}
if (failures.length > 0) {
  throw new Error(`webhook fan-out failed for ${failures.length}/${webhooks.length} webhooks: ${failures.map((f) => f.webhookId).join(',')}`);
}
```
Retry safety: the `(webhook_id, event_id)` unique insert + "the sweep is the single re-queue owner" semantics make a retried fan-out skip already-recorded webhooks — a retry only re-attempts the failed ones. Test: a `getWebhooksForEvent` rejection propagates; one-of-two record failures still records the other AND throws.

- [ ] **Step 2: `automationWorker.ts`** — export `handleAutomationEvent(event)`: current body, but `!isRedisAvailable()` becomes `throw new Error('redis unavailable for automation trigger dispatch')` (retryable in queue mode; local wrapper swallows it exactly as today) and the outer try/catch is removed (the `queueEventTriggers` Branch-B rethrow now propagates). Keep the Quick-Support kill-switch early return (a drop by design, not a failure). Test: `queueEventTriggers` rejection propagates out of the handler.

- [ ] **Step 3: `policyAlertBridge.ts`** — export `handlePolicyViolationEvent(event)` / `handlePolicyCompliantEvent(event)` wrapping `runWithSystemDbAccess(handlePolicyViolation/Compliant)` WITHOUT the current catch-and-swallow. Registered with `eventTypes: ['policy.violation']` / — no: ONE subscriber id per module. Register a single `policy-alert-bridge` subscriber with `eventTypes: ['policy.violation', 'policy.compliant']` whose handler switches on `event.type`. Test: a DB rejection propagates.

- [ ] **Step 4: `notificationDispatcher.ts`** — export `handleAlertLifecycleEvent(event)` switching on `alert.triggered|acknowledged|resolved` (keeping the `payload.alertId` truthiness guard, now with a `console.warn` when absent instead of a silent no-op), no catch-all. Registered as `notification-dispatcher`, `eventTypes: ['alert.triggered', 'alert.acknowledged', 'alert.resolved']`. Delete `subscribeToAlertEvents()` (it also had no idempotence guard — the registry's duplicate-id throw now provides one).

- [ ] **Step 5: `dnsThreatAlerts.ts`** — export `handleDnsThreatBlockedEvent(event)` = `handleDnsThreatBlocked(event.orgId, event.payload)` without the catch (keep the structured log, then rethrow). Registered as `dns-threat-alerts`, `eventTypes: ['dns.threat.blocked']`.

- [ ] **Step 6: `eventSubscribers.ts`** — synchronous module registering all five via `registerEventSubscriber`, guarded by a module-level `let registered = false`. Retry policies: `webhook-delivery`/`automation-worker`/`notification-dispatcher` `{attempts: 5, backoffMs: 10_000}`; `policy-alert-bridge`/`dns-threat-alerts` `{attempts: 3, backoffMs: 30_000}`. In `index.ts`: call `registerAllEventSubscribers({...})` synchronously immediately before `initializeWorkers()` is invoked (~index.ts:2021), passing the same `getWebhooksForEvent`/`createDeliveryRecord` closures currently built at index.ts:1268-1329; strip the `subscribe()` calls from the five init functions (their remaining init work — worker loops, queues — stays in the `workers` array).

- [ ] **Step 7: Static contract test** (`eventSubscribers.contract.test.ts`, source-scan style like `eventBus.types.test.ts`): `readFileSync` the five production modules and assert none contains `.subscribe(` on the global bus (regex `getEventBus\(\)\.subscribe|eventBus\.subscribe`) — dual registration (registry + legacy) would double-deliver (codex Q3 hole #3). Also assert `eventSubscribers.ts` registers every id in `EVENT_SUBSCRIBER_IDS` exactly once.

- [ ] **Step 8: Run** all touched module tests + the contract test → PASS. Typecheck (`cd apps/api && npx tsc --noEmit` if memory allows, else rely on turbo).

- [ ] **Step 9: Commit** — `refactor(api): five event subscribers move to the durable registry with throwing handlers`

---

### Task 4: `event_delivery_receipts` — migration, schema, cascade/export registration

**Files:**
- Create: `apps/api/migrations/2026-09-11-e-event-delivery-receipts.sql`
- Create: `apps/api/src/db/schema/eventDispatch.ts` (+ export from `schema/index.ts`)
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, alphabetical), `apps/api/src/services/tenantExportPolicyRegistry.ts` (`CORE_TENANT_EXPORT_POLICY`)
- Test: covered by existing contract suites (`rls-coverage`, `tenantCascade`, `tenant-export-policy` — run under Integration)

- [ ] **Step 1: Migration** (shape 1, template `2026-08-22-ticket-email-links.sql`):

```sql
-- Wave 3.5c (#4085): durable delivery receipts, keyed (event_id, subscriber_id).
-- Tenancy shape 1 (direct org_id). Written ONLY under system DB context by the
-- event-dispatch worker; org policies exist for the RLS contract + GDPR erasure.
-- status: planned -> delivering -> delivered | failed. 'delivering' found on a
-- retry means a crash mid-handler: outcome unknown, re-claimed (at-least-once).
CREATE TABLE IF NOT EXISTS event_delivery_receipts (
  event_id varchar(100) NOT NULL,
  subscriber_id varchar(50) NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  event_type varchar(100) NOT NULL,
  mode varchar(10) NOT NULL,               -- 'shadow' | 'enforce'
  status varchar(12) NOT NULL DEFAULT 'planned',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  delivered_at timestamp,
  PRIMARY KEY (event_id, subscriber_id)
);

CREATE INDEX IF NOT EXISTS event_delivery_receipts_org_idx ON event_delivery_receipts (org_id);
-- Retention scans delete by age + terminal status; partial keeps it cheap.
CREATE INDEX IF NOT EXISTS event_delivery_receipts_retention_idx
  ON event_delivery_receipts (created_at)
  WHERE status IN ('delivered', 'failed');
-- Shadow comparison + drift metrics scan recent rows by mode.
CREATE INDEX IF NOT EXISTS event_delivery_receipts_mode_created_idx
  ON event_delivery_receipts (mode, created_at);

ALTER TABLE event_delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_delivery_receipts FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_delivery_receipts' AND policyname = 'breeze_org_isolation_select') THEN
    EXECUTE $POLICY$ CREATE POLICY breeze_org_isolation_select ON event_delivery_receipts FOR SELECT USING (public.breeze_has_org_access(org_id)) $POLICY$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_delivery_receipts' AND policyname = 'breeze_org_isolation_insert') THEN
    EXECUTE $POLICY$ CREATE POLICY breeze_org_isolation_insert ON event_delivery_receipts FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id)) $POLICY$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_delivery_receipts' AND policyname = 'breeze_org_isolation_update') THEN
    EXECUTE $POLICY$ CREATE POLICY breeze_org_isolation_update ON event_delivery_receipts FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id)) $POLICY$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_delivery_receipts' AND policyname = 'breeze_org_isolation_delete') THEN
    EXECUTE $POLICY$ CREATE POLICY breeze_org_isolation_delete ON event_delivery_receipts FOR DELETE USING (public.breeze_has_org_access(org_id)) $POLICY$;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_delivery_receipts TO breeze_app;
```
(Mirror the exact policy-creation idiom of the template file if it differs — the `pg_policies` existence-check + dollar-quoted `EXECUTE` shape above matches `2026-08-23-abuse-endpoint-fingerprints.sql`.)

- [ ] **Step 2: Drizzle schema** in `schema/eventDispatch.ts` matching every column/index above (composite PK via `primaryKey({ columns: [table.eventId, table.subscriberId] })`; partial index via `.where(sql\`status IN ('delivered','failed')\`)`); export from the schema barrel. No payload column, no jsonb (export-policy `excludedOpen` avoidance is by construction). `last_error` is truncated to 500 chars by the writer (Task 6).

- [ ] **Step 3: Cascade + export registration.** Add `'event_delivery_receipts'` to `CORE_ORG_CASCADE_DELETE_ORDER` in alphabetical position (verify with the test's `localeCompare` rule; FK is only to `organizations`, which is last — order is satisfied). Add `tablePolicy('event_delivery_receipts', { included: ['event_id','subscriber_id','org_id','event_type','mode','status','attempts','last_error','created_at','updated_at','delivered_at'] })` to `CORE_TENANT_EXPORT_POLICY` (match the file's exact helper signature — copy an adjacent entry's shape).

- [ ] **Step 4: `pnpm db:check-drift`** → clean. Run `cd apps/api && npx vitest run src/db/autoMigrate.test.ts` → PASS (naming/ordering guard).

- [ ] **Step 5: Contract suites against real PG** (also re-run in Task 13): `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts` → PASS.

- [ ] **Step 6: Commit** — `feat(api): event_delivery_receipts table (durable per-subscriber receipts, #4085)`

---

### Task 5: Dispatch queue + publish() ingress with plan snapshot

**Files:**
- Create: `apps/api/src/services/eventDispatchQueue.ts`
- Modify: `apps/api/src/services/eventBus.ts` (`publish()`, inside the `runOutsideDbContext` block after the two pub/sub PUBLISHes, before `invokeLocalHandlers`)
- Modify: `apps/api/src/jobs/queueSchemas.ts` (route/deliver job payload schemas)
- Test: `apps/api/src/services/eventDispatchQueue.test.ts`, extend `eventBus.test.ts`

**Interfaces:**
- Produces:
```ts
export const EVENT_DISPATCH_QUEUE = 'event-dispatch';
export interface RouteEventJobData {
  v: 1;
  mode: 'shadow' | 'enforce';
  event: BreezeEvent;                    // verbatim — original id preserved by construction
  matchedSubscriberIds: SubscriberId[];  // publisher's full matched set, sorted
  queueSubscriberIds: SubscriberId[];    // publisher's queue partition, sorted (enforce) / = matched (shadow)
}
export interface DeliverEventJobData {
  v: 1; subscriberId: SubscriberId; event: BreezeEvent;
}
export function getEventDispatchQueue(): Queue;           // createInstrumentedQueue singleton
export function enqueueRouteEvent(event: BreezeEvent): Promise<void>; // computes partition, never throws
export function recordShadowLocalInvocation(event: BreezeEvent, subscriberId: SubscriberId, outcome: 'ok' | 'error'): Promise<void>;
export function shutdownEventDispatchQueue(): Promise<void>;
```

- [ ] **Step 1: Failing tests** — with a mocked queue (the `createInstrumentedQueue` partial-double pattern, bullmqQueue.ts:52-58) and stubbed env: mode `off` → `enqueueRouteEvent` adds nothing; `shadow` → one `route-event` add with `jobId: 'event-route-<eventId>'`, `queueSubscriberIds === matchedSubscriberIds`; `enforce` + csv → `queueSubscriberIds` is exactly the matched∩csv sorted set; a rejected `queue.add` is caught, logged with `errorId: 'EVENT_DISPATCH_ENQUEUE_FAILED'`, `captureException`d, and NOT rethrown (publish must not fail — parity with today's swallow; the XADD stream stays the forensic record and this is the documented not-an-outbox gap); `publishUserEvent` never enqueues (it doesn't call `publish`, assert no add across a `publishUserEvent` call).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Job options for `route-event`: `{ jobId: \`event-route-${event.id}\`, attempts: 5, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: { count: 1000 }, removeOnFail: { age: 7 * 24 * 3600 } }`. `recordShadowLocalInvocation`: fire-and-forget Redis `HSET breeze:event-shadow:local:<eventId> <subscriberId> <outcome>` + `EXPIRE 7200`, only when `eventDispatchMode() === 'shadow'` AND the event is sampled — sampling rule (codex Q6): 100% for `alert.*` and `policy.*` types, else `parseInt(event.id.slice(0, 2), 16) < 26` (~10% deterministic by id hash).

- [ ] **Step 4: Wire into `publish()`** after the global PUBLISH (eventBus.ts:309), before `invokeLocalHandlers`: `const mode = eventDispatchMode(); if (mode !== 'off') { await enqueueRouteEvent(event); }`. In `invokeLocalHandlers`'s registry loop (Task 2), when mode is `shadow`, call `recordShadowLocalInvocation(event, sub.id, ok|error)` around each local execution.

- [ ] **Step 5: queueSchemas.ts** — add `.strict()` Zod schemas for both job payloads to the central registry (match the file's discriminated-union pattern); run `npx vitest run src/jobs/queueSchemas.test.ts` → PASS.

- [ ] **Step 6: Run all touched tests** → PASS. **Step 7: Commit** — `feat(api): route-event ingress with publisher plan snapshot (#4085)`

---

### Task 6: Dispatch worker — router, delivery with receipt CAS, boot phase-2

**Files:**
- Create: `apps/api/src/jobs/eventDispatchWorker.ts`
- Modify: `apps/api/src/index.ts` (start AFTER the `Promise.allSettled` at :1463-1481; add `shutdownEventDispatchWorker` to `shutdownTasks` before `getEventBus().close()`)
- Test: `apps/api/src/jobs/eventDispatchWorker.test.ts`

**Interfaces:**
- Consumes: `RouteEventJobData`/`DeliverEventJobData` (Task 5), `getSubscriberById` (Task 2), `eventDeliveryReceipts` schema (Task 4).
- Produces: `initializeEventDispatchWorker(): Promise<void>` (no-op when mode is `off` — but ALWAYS starts if mode is shadow/enforce OR the queue is non-empty, so a mode flip back to off still drains in-flight jobs); `shutdownEventDispatchWorker(): Promise<void>`.

Processor semantics (write failing tests per branch first — mock DB with the Drizzle mock pattern, mock queue; then implement):

- [ ] **Step 1: Route processing (`route-event`)** — trusts the snapshot verbatim, NEVER recomputes routing (codex D3/Q3):
  1. Bulk-insert receipts for `queueSubscriberIds`: one `insert(eventDeliveryReceipts).values([...]).onConflictDoNothing()` with `{ eventId, subscriberId, orgId: event.orgId, eventType: event.type, mode, status: 'planned' }` — conflict = route-job retry, benign.
  2. `mode === 'shadow'` → stop here (receipts ARE the mirror; no deliver jobs, nothing executes).
  3. `mode === 'enforce'` → `queue.addBulk` one `deliver-event` per queue subscriber: `{ name: 'deliver-event', data: { v: 1, subscriberId, event }, opts: { jobId: \`event-deliver-${subscriberId}-${event.id}\`, attempts: sub.retry?.attempts ?? 5, backoff: { type: 'exponential', delay: sub.retry?.backoffMs ?? 10_000 }, removeOnComplete: { count: 1000 }, removeOnFail: { age: 7 * 24 * 3600 } } }`.
  All DB work inside a short `withSystemDbAccessContext`; the `addBulk` via `runOutsideDbContext` (intentOutboxPublisher.ts:9-51 is the reference for this split).
- [ ] **Step 2: Delivery processing (`deliver-event`)** — the receipt state machine:
  1. Unknown `subscriberId` in the registry → log + `captureException` + return (terminal: a subscriber removed in a later deploy must not retry forever).
  2. Read receipt by PK. `status === 'delivered'` → return (idempotent skip — this is the post-retention dedupe that BullMQ retention cannot provide).
  3. Claim: `UPDATE ... SET status='delivering', attempts=attempts+1, updated_at=now() WHERE event_id=? AND subscriber_id=? AND status <> 'delivered'` (compiled-SQL-assert this CAS in the unit test — vacuous-Drizzle-assertion rule). Zero rows + no receipt at all → insert one first (`planned`, then claim — covers a route/deliver race), zero rows with an existing `delivered` row → return.
  4. `await sub.handler(job.data.event)` — NO try/catch around the business error path: a throw fails the BullMQ job → per-subscriber retry → BullMQ failed-set after exhaustion. On throw, first CAS `delivering → failed` with `last_error: String(error).slice(0, 500)`, then rethrow.
  5. Success → CAS `delivering → delivered`, `delivered_at = now()`.
  Receipt semantics note (comment in code): a `delivered` receipt proves the subscriber HANDLER completed — usually "downstream job accepted", not that an email/webhook egress completed.
- [ ] **Step 3: Worker config** — `new Worker(EVENT_DISPATCH_QUEUE, processor, { connection: getBullMQConnection(), concurrency: 5 })` (conservative until the order-independence fixes in Tasks 8-9 have soaked; note in code) + `attachWorkerObservability(worker, 'eventDispatch')`. Boot: in `index.ts`, AFTER the `Promise.allSettled` block completes (a new phase-2 line next to `readiness.invalidate()`), `await initializeEventDispatchWorker()` guarded by the same redis-availability check; failure → same `[CRITICAL]` + `captureException` + `workerStatus['eventDispatch'] = false` handling. This ordering (sync registry → allSettled inits → dispatch worker) is what guarantees the worker never sees a partially-installed registry.
- [ ] **Step 4: Run unit tests** → PASS. **Step 5: Commit** — `feat(api): event-dispatch worker with durable receipt state machine (#4085)`

---

### Task 7: Receipt retention + shadow comparison job

**Files:**
- Modify: `apps/api/src/jobs/eventDispatchWorker.ts` (both repeatables live here), `apps/api/src/jobs/scheduleRegistry.ts` (`JOB_SCHEDULES` entry for retention)
- Test: extend `eventDispatchWorker.test.ts`; `scheduleRegistry.contract.test.ts` must stay green

- [ ] **Step 1: Retention** — coarse (daily) → MUST use a scheduleRegistry cron lane, never `every:` (epoch-stampede rule). Add `eventDeliveryReceiptRetention` to `JOB_SCHEDULES` in the daily tier (pick the next free minute in the `≡ 3 (mod 5)` lane per the file's allocation comment). Job body: batched deletes in a loop, each `DELETE FROM event_delivery_receipts WHERE ctid IN (SELECT ctid FROM event_delivery_receipts WHERE status = 'delivered' AND created_at < now() - interval '7 days' LIMIT 5000)` until 0 rows, then the same for `status IN ('failed','planned','delivering') AND created_at < now() - interval '30 days'` (failed kept longer for forensics; `planned`/`delivering` older than 30d are lost jobs — log the count at warn with `errorId: 'EVENT_DISPATCH_RECEIPTS_ABANDONED'` before deleting). Run `npx vitest run src/jobs/scheduleRegistry.contract.test.ts` → PASS.
- [ ] **Step 2: Shadow comparison** — sub-hourly repeatable (`every: 5 * 60 * 1000`, webhookDeliveryRecovery.ts:554-563 registration idiom: remove existing repeatables, re-add), active only when mode is `shadow`. Body: (a) counts — per subscriber, receipts created in the last 15 min vs Redis local-invocation counters (`HINCRBY breeze:event-shadow:count:<subscriberId>:<ok|error>` bumped by `recordShadowLocalInvocation`; compare, log one summary line per run); (b) samples — for up to 200 sampled receipts from the window, `HGETALL breeze:event-shadow:local:<eventId>` and diff the subscriber-id sets both ways (router-planned-but-not-locally-run and vice versa); any mismatch → `console.error` with `errorId: 'EVENT_DISPATCH_SHADOW_MISMATCH'` + `captureException` + `LPUSH breeze:event-shadow:mismatches` (LTRIM 0 999). Mismatches are always retained regardless of sampling. This is the parity evidence gate for enforce.
- [ ] **Step 3: Tests** — retention deletes only past-window terminal rows (mock DB, assert compiled WHERE); comparison flags a planted swap (event A missing subscriber X locally, event B doubled) that equal totals would conceal. Run → PASS.
- [ ] **Step 4: Commit** — `feat(api): receipt retention + shadow-mode comparison (#4085)`

---

### Task 8: `alert_notifications` send identity — migration + claim-style state machine

**Files:**
- Create: `apps/api/migrations/2026-09-11-f-alert-notifications-send-identity.sql`
- Modify: `apps/api/src/db/schema/alerts.ts` (:234-242), `apps/api/src/services/notificationDispatcher.ts` (`processSendNotification`, insert at :415)
- Test: extend `apps/api/src/services/notificationDispatcher.test.ts`

- [ ] **Step 1: Migration:**

```sql
-- Wave 3.5c (#4085): durable per-channel send identity. A send is
-- (alert_id, channel_id, escalation_step); step 0 = the baseline fan-out,
-- 1..N = escalation waves (matches the send-job data model,
-- notificationDispatcher.ts scheduleEscalation).
ALTER TABLE alert_notifications ADD COLUMN IF NOT EXISTS escalation_step integer NOT NULL DEFAULT 0;

-- Historical duplicates exist legitimately (BullMQ retries inserted fresh rows).
-- Keep the best row per identity: prefer status='sent', then newest. Forensic
-- rule: report the count even when 0.
DO $$
DECLARE n integer;
BEGIN
  DELETE FROM alert_notifications a USING (
    SELECT id, row_number() OVER (
      PARTITION BY alert_id, channel_id, escalation_step
      ORDER BY (status = 'sent') DESC, created_at DESC, id DESC
    ) AS rn
    FROM alert_notifications
  ) ranked
  WHERE a.id = ranked.id AND ranked.rn > 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'deduplicated % alert_notifications rows before send-identity unique index', n; END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS alert_notifications_send_identity_uq
  ON alert_notifications (alert_id, channel_id, escalation_step);
```
`alert_notifications` has no `org_id` (derived scope via `alert_id`) — no cascade/export registration fires. Update the Drizzle schema (column + `uniqueIndex`), `pnpm db:check-drift` → clean.

- [ ] **Step 2: Failing tests for the state machine** — (a) first invocation inserts `pending` with `escalationStep: data.escalationStep ?? 0` (the `?? 0` is load-bearing — a schema default alone won't stop an explicit null); (b) a retry after a crashed pending row REUSES that row (no second insert — assert `onConflictDoNothing` target is the identity triple via compiled SQL); (c) an existing `sent` row → skip, job completes, NO egress call; (d) a transport failure updates the row to `failed` AND THROWS (today it returns `{success:false}` at :649, so `attempts: 3` never actually retried transport failures — this is the codex-flagged defect); (e) success CASes to `sent` guarded `status <> 'sent'`.
- [ ] **Step 3: Implement** in `processSendNotification`: replace the bare insert at :415 with insert-`onConflictDoNothing`-returning → on empty, select the existing row by identity → `sent` ⇒ return skip; else UPDATE claim (`SET status='pending', updated? — table has no updated_at; use error_message=NULL WHERE id=? AND status <> 'sent'`). On egress failure: `UPDATE SET status='failed', error_message=? WHERE id=?` then `throw` the transport error. Keep the existing per-channel disabled/unknown early-return (`{send:false}` + warn) — that is a deliberate skip, not a failure.
- [ ] **Step 4: Run** the dispatcher unit tests → PASS. **Step 5: Commit** — `feat(api): durable per-channel send identity for alert notifications (#4085)`

---

### Task 9: Notification ordering hardening — status guards, stable jobIds, failed-job recovery

**Files:**
- Modify: `apps/api/src/services/notificationDispatcher.ts` (`processAlertNotifications` :159-315, `scheduleEscalation` :1018-1071, `dispatchAlertNotifications` :1104-1145)
- Test: extend `notificationDispatcher.test.ts`

Cancellation (`cancelAlertEscalations`) only removes jobs that are DELAYED at that moment; it is an optimization, not the correctness mechanism. Under queue delivery, `alert.resolved` can process before a retried `alert.triggered` delivery, which then re-schedules escalations nobody will cancel. Durable status checks are the fix (quorum-required):

- [ ] **Step 1: Failing tests** — (a) `processAlertNotifications` no-ops (no addBulk, no scheduleEscalation) when the loaded alert's status is `resolved`; (b) an escalation `send` job (`escalationStep >= 1`) re-loads the alert at fire time and skips egress unless status is `active` (an acknowledged alert must not escalate — that is what cancel-on-ack expresses); (c) baseline `send` jobs are enqueued with `jobId: \`alert-send-${alertId}-${channelId}-0\`` (today: no jobId at :285-300, so a retried `process-alert` re-runs `addBulk` and duplicates the whole baseline fan-out); (d) `dispatchAlertNotifications` inspects the job returned by `queue.add` and, when its state is `failed`, calls `job.retry()` (BullMQ returns the existing job for a duplicate id WITHOUT enqueuing — a redelivered `alert.triggered` against a failed `process-alert` hash was previously a silent permanent drop) — wrap `retry()` in try/catch (it races with removal; a `removeOnFail` age purge between `getState` and `retry` is benign).
- [ ] **Step 2: Implement all four.** For (b), the guard lives at the top of `processSendNotification` when `escalationStep >= 1`: re-select the alert's status; `!== 'active'` → return a skip result (row untouched — do not mark `failed`). For (a): `if (alert.status === 'resolved') return;` after the existing alert load at :167-171 (acknowledged still gets the baseline — preserves today's ack semantics where only escalations are cancelled).
- [ ] **Step 3: Run** → PASS. **Step 4: Commit** — `fix(api): alert notification ordering guards + stable send jobIds (#4085)`

---

### Task 10: policyAlertBridge — reconcile from persisted truth

**Files:**
- Modify: `apps/api/src/services/policyAlertBridge.ts` (`handlePolicyViolation` ~:150-212)
- Test: extend `apps/api/src/services/policyAlertBridge.test.ts`

The event is a wake-up, not the truth. `automation_policy_compliance` (schema/automations.ts:128, upserted by `policyEvaluationService.ts:1393/1403` BEFORE the events publish at :1210-1231) holds the current status per `(policy_id, device_id)`. A delayed/retried `policy.violation` that lands after a newer `policy.compliant` must not create a stale alert — and FIFO cannot fix this (a failed violation delivery can retry after a later compliant), so reconcile:

- [ ] **Step 1: Failing test** — `handlePolicyViolation` with a compliance row whose `status` is `'compliant'` for the payload's `(policyId, deviceId)` creates NO alert; with `'non_compliant'` (or no row at all — evaluation row deleted, keep today's behavior) it proceeds.
- [ ] **Step 2: Implement** — after the existing policy-ownership validation, before `ensureRule`:

```ts
const [compliance] = await db
  .select({ status: automationPolicyCompliance.status })
  .from(automationPolicyCompliance)
  .where(and(
    eq(automationPolicyCompliance.policyId, payload.policyId),
    eq(automationPolicyCompliance.deviceId, payload.deviceId),
  ))
  .limit(1);
if (compliance && compliance.status !== 'non_compliant') {
  // Stale or reordered violation event: the persisted evaluation state has
  // moved on. The compliant-side handler resolves alerts; creating one here
  // would strand an active alert with no future event to clear it.
  return;
}
```
(`handlePolicyCompliant` is already safe out of order: resolving via the #4099 CAS is idempotent, and the violation-side reconcile above closes the compliant-then-late-violation hole.)
- [ ] **Step 3: Run** → PASS. **Step 4: Commit** — `fix(api): policy alert bridge reconciles against persisted compliance state (#4085)`

---

### Task 11: Delete the dead consumer-group half of EventBus + drop `event_bus_events`

**Files:**
- Modify: `apps/api/src/services/eventBus.ts`, `apps/api/src/services/eventBus.test.ts`
- Create: `apps/api/migrations/2026-09-11-g-drop-event-bus-events.sql`
- Modify: `apps/api/src/db/schema/integrations.ts` (:121-130), `apps/api/src/services/tenantCascade.ts` (:202), `apps/api/src/services/tenantExportPolicyRegistry.ts` (:164)

Quorum: keep NONE of it. Every member has zero production callers, and `retryDeadLetter` is the id-destroying trap (republishes via `publish()`, which mints a fresh UUID at :259, bypassing every 3.5a dedupe key — the exact defect #4085 documents).

- [ ] **Step 1: Delete** from `eventBus.ts`: `startConsuming`, `consumeLoop`, `processMessage`, `stopConsuming`, `getBlockingRedis` (+ the `blockingRedisClient` field and its `createBlockingRedisConnection` import if now unused), `replay`, `getPending`, `getDeadLetterQueue`, `retryDeadLetter`, `CONSUMER_GROUP`, the consumer-name pid logic, and the `breeze:events:dlq` writers. `close()` shrinks to quitting `redisClient`. The stream XADD, both pub/sub channels, `subscribe()`, `publishUserEvent`, and `invokeLocalHandlers` are UNTOUCHED. Delete the two `(bus as any).processMessage` test cases (eventBus.test.ts:143-179, :339-371 exercise subscription via processMessage — rewrite them to drive `invokeLocalHandlers` via `publish` with mocked redis, preserving the assertions on handler invocation and unsubscribe).
- [ ] **Step 2: Migration** `2026-09-11-g-drop-event-bus-events.sql`: `DROP TABLE IF EXISTS event_bus_events;` with a header noting it was never wired to any reader or writer (schema scaffolding; verified zero `insert`/`select` repo-wide 2026-08-26). Remove the Drizzle definition and the two registry strings. `pnpm db:check-drift` → clean.
- [ ] **Step 3: Run** `npx vitest run src/services/eventBus.test.ts src/services/eventBus.types.test.ts src/db/autoMigrate.test.ts` and grep the repo for any lingering reference (`grep -rn "startConsuming\|retryDeadLetter\|getDeadLetterQueue\|eventBusEvents" apps/api/src` → only webhookDelivery's own unrelated `getDeadLetterQueue` remains). Typecheck.
- [ ] **Step 4: Commit** — `refactor(api): delete dead event-bus consumer half + never-wired event_bus_events table (#4085)`

---

### Task 12: Integration suites (real Postgres + Redis)

**Files:**
- Create: `apps/api/src/__tests__/integration/eventDispatchQueue.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/alertNotificationSendIdentity.integration.test.ts`
- Modify: `apps/api/vitest.integration.config.ts` — **add BOTH files to the explicit `include` list** (a file not listed there runs in ZERO CI jobs).

Model file: `apps/api/src/jobs/authEmailWorker.integration.test.ts` (real DB + Redis, private-container recipe in its header). Import `'../__tests__/integration/setup'` first; note `flushdb()` runs between tests, so build queues/workers inside each test.

- [ ] **Step 1: `eventDispatchQueue.integration.test.ts`** — cases, each proven red first by reverting its fix:
  1. **Enforce end-to-end:** register a test subscriber (registry reset hook), publish with mode `enforce` + csv containing it, run a real `Worker` on `event-dispatch`, assert: handler ran exactly once with the ORIGINAL `event.id`; receipt row is `delivered`; the local path did NOT invoke it (exactly-one-of).
  2. **Receipt idempotent skip:** pre-insert a `delivered` receipt, enqueue the deliver job manually, assert the handler is NOT invoked (this is the automation post-retention dedupe BullMQ retention cannot give — the quorum's deciding case).
  3. **Failure → retry → receipt failed:** a handler that throws twice then succeeds; assert `attempts` on the receipt reflects the claims and final status is `delivered`; a handler that always throws ends `failed` with `last_error` populated.
  4. **Shadow writes receipts, executes nothing:** mode `shadow`, publish, run router; receipts exist with `mode='shadow'` `status='planned'`, no deliver jobs on the queue, and the local handler DID run.
  5. **RLS forge:** as `breeze_app` under an org context for org B, attempt to read/write org A's receipt rows → 0 rows / RLS violation (42501).
- [ ] **Step 2: `alertNotificationSendIdentity.integration.test.ts`** — the unique index is real (double insert of the identity triple → second returns empty under `onConflictDoNothing`); the migration's dedupe DELETE keeps the `sent` row when a `sent` + `pending` duplicate pair exists (replay the migration file by path — and note any rename must sweep such references).
- [ ] **Step 3: Run both** with the private-container recipe → PASS, and **verify in the output that the files actually EXECUTED** (test counts > 0), not merely discovered.
- [ ] **Step 4: Commit** — `test(api): event dispatch + send identity integration suites (#4085)`

---

### Task 13: Spec amendment, contract-suite pass, PR

**Files:**
- Modify: `docs/superpowers/specs/ai-mcp/2026-08-22-ai-agents-program-and-wave1-design.md` (:48 area)

- [ ] **Step 1: Amend the spec** — replace the "event bus consumer-group dispatch" line with a short dated note: wave 3.5c (#4085) ships BullMQ route/deliver dispatch with durable Postgres receipts instead of Redis Streams consumer groups; rationale: the consumer-group implementation was defective five ways and per-subscriber retry isolation is the actual requirement; decided by advisor quorum 2026-08-26 (this plan is the ADR).
- [ ] **Step 2: Full local gates** — `cd apps/api && npx tsc --noEmit` (or turbo build), `pnpm --filter @breeze/api test --run` scoped runs already done per task; now the contract suites (tenancy/cascade code WAS touched): rls-coverage, tenantCascade, tenant-export-policy + roundtrip, both new integration files, `autoMigrate.test.ts`, `scheduleRegistry.contract.test.ts`, `envComposeParity.test.ts`, `composeBindMounts.test.ts`.
- [ ] **Step 3: Open the PR** — branch `feature/3821-ai-agents/wave-4085`, title `feat(api): wave 3.5c — durable event dispatch (BullMQ ingress + per-subscriber delivery receipts)`, body: summary per subsystem, rollout plan (deploy with mode off → shadow one region ≥48h → enforce cohort `notification-dispatcher` first, then `automation-worker`, `policy-alert-bridge`, `dns-threat-alerts`, `webhook-delivery` last — it egresses to customers), the shadow-mismatch evidence gate, `Closes #4085`. **Open the PR and STOP** — no merge, no issue closing (per standing instruction). Request one independent review round.

---

## Deliberately out of scope (documented, not forgotten)

- Migrating `webhookDelivery`'s internal LPUSH/BRPOP list to BullMQ (the #4098 sweep backstops it; separate wave if ever).
- `plugins.ts` PluginEventBridge (never registered in production; needs the full envelope + `(plugin_id, hook, event_id)` receipts — recorded in the 3.5a plan).
- Transactional-outbox semantics (crash between XADD and `queue.add` still loses dispatch — issue #4085 records this as accepted; the destination would be a Postgres outbox like `intent_outbox`).
- `BREEZE_ROLE` split, compose worker service (wave 3.5d, #4086), socket affinity (wave 3.5b, #4084).
- Webhook lifecycle-ordering guarantees (`resolved` before `triggered` into the webhook FIFO) — at-least-once/unordered is the documented contract; revisit only on customer signal.
- BullMQ Pro-style per-key FIFO groups; `event.priority` → BullMQ priority mapping (v1 ignores priority).

## Self-review notes

- Issue requirements → tasks: stable subscriber id (T2/T3), per-subscriber retry policy (T3/T6), durable receipt `(event_id, subscriber_id)` (T4/T6), never-retry-the-fan-out (per-subscriber jobs, T6), original-id replay (event verbatim in job data, T5/T6; asserted in T12 case 1), local/queue exclusivity (T2 partition + T12 case 1), shadow-first rollout (T5/T7/T13), handler failure propagation (T3), `alert_notifications` durable dedupe (T8), spec amendment (T13), `publishUserEvent` untouched (T5 test), dead `startConsuming` (T11 deletes it).
- Codex blocking findings → tasks: plan snapshot (T5), boot race (T3 sync phase + T6 phase-2), dual registration (T3 contract test), receipts over Redis (T4/T6), send-jobId absence (T9c), transport-failure non-retry (T8d), failed-hash recovery via `job.retry()` (T9d), status guards (T9a/b), policy reconcile (T10), `escalationStep ?? 0` (T8a), shadow sampling + mismatch retention (T5/T7).
- Type consistency: `SubscriberId` (T1) flows through T2 registry, T5 job data, T6 processor; `RouteEventJobData`/`DeliverEventJobData` defined once in T5 and consumed in T6; receipt statuses `planned|delivering|delivered|failed` consistent across T4 SQL, T6 CAS, T7 retention, T12 assertions.
