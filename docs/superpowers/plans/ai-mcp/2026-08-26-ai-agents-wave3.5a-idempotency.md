# AI Agents Wave 3.5a — Delivery Idempotency & Atomic Winners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every global event-bus subscriber and every cross-process scheduled job safe to run twice, so that the `BREEZE_ROLE` worker split (wave 3.5d) cannot silently duplicate customer-visible side effects.

**Architecture:** No topology change and no delivery-semantics change in this wave. Each unsafe side effect gains a *durable* uniqueness key (Postgres unique index or an existing partial-unique `dedupe_key` column) or an *atomic winner predicate* (`UPDATE … WHERE status IN (…) RETURNING`), replacing today's check-then-act and BullMQ-retention-window protection. Everything here ships and deploys on the current single-container topology and is independently valuable.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL, BullMQ + Redis, Vitest.

**Tracking:** feature `LanternOps/breeze#3821`, wave sub-issue `#3825` (W04). Branch `feature/3821-ai-agents/wave-3825`.

---

## Why this is wave 3.5**a** and not all of #3825

Issue #3825 is titled "BREEZE_ROLE worker split, setInterval→repeatables, event-bus consumer-group dispatch". Investigation on 2026-08-26 (Claude + an independent Codex `xhigh` review, both reading the code) found that **this is not one wave, and the title omits its hardest prerequisite.** Recommend splitting #3825 into four sub-waves:

| Sub-wave | Content | Gate |
|---|---|---|
| **3.5a** (this plan) | Durable idempotency + atomic winners for all six global subscribers and the unsafe timers | Ships on current topology; no flag |
| **3.5b** | **Socket-affinity resolution** — the release blocker below | Must land before any split |
| **3.5c** | `C′` event dispatch (BullMQ ingress + per-subscriber delivery jobs), gated, proven inside the existing `all` process | Flag-gated, shadow first |
| **3.5d** | `BREEZE_ROLE` split, separate entrypoints, compose `worker` service, droplet deploy + parity | Region-at-a-time |

### The release blocker (3.5b) — verified, not theoretical

`sendCommandToAgent()` (`apps/api/src/routes/agentWs.ts:3067`) resolves the target socket from an **in-process `Map`**: `activeConnections.get(agentId)`. `isAgentConnected()` (`agentWs.ts:3124`) is `activeConnections.has()`. Four BullMQ workers import and call these directly:

- `apps/api/src/jobs/monitorWorker.ts:162,168`
- `apps/api/src/jobs/backupWorker.ts:502,653`
- `apps/api/src/jobs/discoveryWorker.ts:571,606`
- `apps/api/src/jobs/snmpWorker.ts` (imports at :16, used at :412)

Move those workers into a `worker` container and **every agent reads as disconnected**: discovery and backup jobs fail, monitor and SNMP quietly report "no online agent". This breaks agent command dispatch independently of anything to do with the event bus, and no test covers it because today publisher and worker are the same process. Either pin socket-affine workers to the `api` role or build a cross-process command relay with durable command identity — that decision is wave 3.5b's subject and is **out of scope here**.

### Design decision (advisor quorum, 2026-08-26)

Both advisors independently rejected activating `startConsuming()` (`services/eventBus.ts:442`) and both chose the BullMQ-bridge option over Redis Streams consumer groups. Recorded here so 3.5c does not relitigate it:

- `startConsuming()` has **no caller** and is not "nearly finished". It creates groups at id `0` (replaying up to ~10k retained events per org on first enable, `eventBus.ts:173,448`), builds `XREADGROUP` multi-stream arguments in the wrong keys-then-IDs order (`eventBus.ts:471`), reads only `>` and never reclaims abandoned pending entries (`eventBus.ts:474`), and **ACKs even when a handler threw** (`eventBus.ts:541`). It also snapshots org ids once at startup, so new orgs are never consumed.
- The spec line (`docs/superpowers/specs/ai-mcp/2026-08-22-ai-agents-program-and-wave1-design.md:48`) says "consumer-group dispatch". **3.5c will diverge from that wording** — amend the spec or record an ADR at that time.
- One retry unit per *subscriber*, never per *event*: retrying a whole fan-out because one handler failed would replay already-successful webhooks, notifications and automations.

### Scope correction: most `setInterval` sites must NOT be converted

Of ~23 `setInterval` call sites in `apps/api/src`, the great majority sweep **process-local** state and must keep one timer per process — converting them to a shared repeatable would break them:

- `services/remoteAccessPolicy.ts:96` and `routes/agentWs.ts:2781` sweep process-local `Map`s → **API-only, keep as-is**.
- `index.ts:2100` drains the **module-local** audit retry queue (`services/auditService.ts:43`) → keep one per role that calls `createAuditLogAsync`; do not make it a global singleton.
- `db/dbPoolHealthMonitor.ts:588`, `services/eventLoopMonitor.ts:238`, `services/streamingSessionManager.ts:500`, `services/llm/openaiSessionManager.ts:50` → per-process by definition.
- Per-connection timers (`routes/agentWs.ts:2005`, `tunnelWs.ts:825,878`, `desktopWs.ts:793,961`, `terminalWs.ts:738,833`, `mcpServer.ts:371`, `clientAi/sessions.ts:748`) → excluded entirely.

Only these are genuinely unsafe under two processes, and **Task 5 below fixes the two that corrupt data** rather than merely duplicating load:

| Timer | Risk | Handled |
|---|---|---|
| `jobs/incidentJobs.ts:231` timeline enricher | Two processes select the same unmarked row, update by id only | **Task 5** |
| `jobs/incidentJobs.ts:256` SLA monitor | "Already escalated" is in-memory; both publish `incident.escalated` | **Task 5** |
| `jobs/reportScheduleWorker.ts:638` | Two processes select the same occurrence, insert duplicate runs before `lastGeneratedAt` updates | **deferred to 3.5d** (Redis-less fallback path only) |
| `jobs/incidentJobs.ts:206` correlation | Read/count/log only — duplicate load, not duplicate data | 3.5d (worker-only placement) |
| `jobs/mtlsCertificateRevocation.ts:177`, `jobs/oauthRevocationRetryWorker.ts:77`, `services/desktopSessionOrphanRecovery.ts:349` | Already guarded (stable job id / `FOR UPDATE SKIP LOCKED` / Redis Lua lease claim) | 3.5d (placement only) |

## Global Constraints

- **Migration naming ceiling.** The newest committed migration is `apps/api/migrations/2026-09-10-device-command-uninstall-provenance.sql`. Shipped filenames run **ahead of real time**, so a migration named for today (`2026-08-26-…`) would replay *before* it on a fresh DB. Every new migration in this plan must be named `2026-09-11-<slug>.sql` or later. Enforced by `scripts/check-migration-naming.sh` (pre-commit + CI) and `apps/api/src/db/autoMigrate.test.ts`.
- **Migrations must be idempotent** (`CREATE UNIQUE INDEX IF NOT EXISTS`, `DO $$ … EXCEPTION`), carry **no inner `BEGIN;`/`COMMIT;`** (`autoMigrate` wraps each file), and **never edit a shipped migration**.
- **Cleanup statements must report row counts.** Any migration that de-duplicates existing rows before adding a unique index must wrap the `DELETE` in `DO $$ … GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN RAISE WARNING 'cleaned % <what>', n; END IF; END $$;`.
- **Export-policy registration IS required — this wave trips the one rule that fires on a new COLUMN.** No new tables are created, so the cascade lists are untouched. But Task 5 adds two columns to `incidents`, which is in `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts:217`) and whose `CORE_TENANT_EXPORT_POLICY` entry (`services/tenantExportPolicyRegistry.ts:179`) enumerates every column. **Both new columns must be added to that entry's `included` list in the same commit.** They are plain timestamps — ordinary customer data, not credentials and not `json`/`jsonb`/`bytea` — so `included` is the correct bucket. Miss this and `tenant-export-policy.integration.test.ts` fails; because it needs a live database it cannot fail in the **Test API** job, so the PR reads green and reds main after merge.
- Verify before committing any schema change: `grep -rn '<table>' apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts`.
- **Do not change delivery semantics in this wave.** Handlers keep their current `try/catch`. Making callbacks propagate failures belongs to 3.5c, where a retry mechanism exists to receive them; doing it here would only convert a swallowed log into a swallowed log one frame higher.
- **Run targeted tests during development, then the affected suites before PR:** `cd apps/api && npx vitest run <path>`. Never `pnpm --filter @breeze/api test -- --run <path>` (the `--` makes vitest run the whole suite in watch mode). Integration suites need a live database: `pnpm --filter @breeze/api test:integration` (no `--`).

---

## File Structure

**Create:**
- `apps/api/migrations/2026-09-11-a-webhook-delivery-event-uniqueness.sql` — unique `(webhook_id, event_id)` on `webhook_deliveries`
- `apps/api/migrations/2026-09-11-b-incident-atomic-winners.sql` — partial unique index backing SLA escalation
- `apps/api/src/services/notificationSenders/inAppSender.dedupe.test.ts`
- `apps/api/src/workers/webhookDelivery.dedupe.test.ts`
- `apps/api/src/jobs/incidentJobs.atomicWinner.test.ts`
- `apps/api/src/__tests__/integration/eventRedeliveryIdempotency.integration.test.ts` — the barrier suite: replays one event of each type twice against real Postgres and asserts exactly one side effect

**Modify:**
- `apps/api/src/db/schema/integrations.ts` — add the unique index to the `webhookDeliveries` table definition
- `apps/api/src/services/notificationDispatcher.ts:1126` — stable `process-alert` job id
- `apps/api/src/services/notificationSenders/inAppSender.ts:129` — set `dedupeKey`
- `apps/api/src/workers/webhookDelivery.ts:448` — conflict-aware delivery creation
- `apps/api/src/services/alertService.ts` — `resolveAlert` compare-and-swap
- `apps/api/src/jobs/incidentJobs.ts:68,143` — atomic claim + winner predicate

---

## Task 1: Stable job id for `process-alert`

The single cheapest fix and the one with the widest blast radius: `alert.triggered` currently enqueues with no `jobId`, so a redelivered event fans out a second full notification set — email, SMS, Slack, Teams, PagerDuty, Pushover — to every on-call tech.

**Files:**
- Modify: `apps/api/src/services/notificationDispatcher.ts` (`dispatchAlertNotifications`, and its `alert.triggered` subscriber at :1126)
- Test: `apps/api/src/services/notificationDispatcher.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `dispatchAlertNotifications(alertId: string, dedupeToken?: string): Promise<void>` — `dedupeToken` defaults to `alertId` so every existing caller keeps working unchanged. Task 6's integration suite relies on this signature.

- [ ] **Step 1: Write the failing test**

```ts
it('enqueues process-alert under a stable job id so a redelivered event cannot double-notify', async () => {
  await dispatchAlertNotifications('alert-1', 'event-1');
  await dispatchAlertNotifications('alert-1', 'event-1');

  const opts = queueAddMock.mock.calls.map(([, , o]) => o?.jobId);
  expect(opts).toEqual(['process-alert-alert-1-event-1', 'process-alert-alert-1-event-1']);
});

it('defaults the dedupe token to the alert id for callers that have no event', async () => {
  await dispatchAlertNotifications('alert-2');
  expect(queueAddMock.mock.calls.at(-1)?.[2]?.jobId).toBe('process-alert-alert-2-alert-2');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/notificationDispatcher.test.ts -t 'stable job id'`
Expected: FAIL — `jobId` is `undefined` because the current `queue.add` passes only `removeOnComplete`/`removeOnFail`.

- [ ] **Step 3: Write minimal implementation**

In `dispatchAlertNotifications`:

```ts
export async function dispatchAlertNotifications(
  alertId: string,
  dedupeToken: string = alertId,
): Promise<void> {
  const queue = getNotificationQueue();

  await queue.add(
    'process-alert',
    { type: 'process-alert', alertId },
    {
      // A redelivered alert.triggered must not fan out a second notification
      // set. BullMQ rejects a duplicate jobId outright, so the token has to be
      // stable for one (alert, event) pair — never randomised, never timestamped.
      // NOTE: this is retention-bounded, not durable — `removeOnComplete: true`
      // frees the id once the job completes. Task 3 adds the durable backstop on
      // the in-app row; the per-channel durable identity lands in wave 3.5c.
      jobId: `process-alert-${alertId}-${dedupeToken}`,
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
}
```

At the `alert.triggered` subscriber (`:1126`), pass the event id through:

```ts
eventBus.subscribe('alert.triggered', async (event) => {
  try {
    const payload = event.payload as { alertId?: string };
    if (payload.alertId) {
      await dispatchAlertNotifications(payload.alertId, event.id);
    }
  } catch (error) {
    console.error('Failed to dispatch alert notifications:', error);
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/notificationDispatcher.test.ts`
Expected: PASS, and no pre-existing test in the file regresses.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/notificationDispatcher.ts apps/api/src/services/notificationDispatcher.test.ts
git commit -m "fix(api): give process-alert a stable job id so redelivery cannot double-notify"
```

---

## Task 2: Durable dedupe on the in-app notification row

Task 1's protection evaporates when BullMQ frees the job id. `user_notifications.dedupeKey` already exists **with a partial unique index** (`db/schema/notifications.ts:41`, added for wave 2's outbox) and `inAppSender` simply never sets it — so this is a one-field fix that turns a retention-window guarantee into a database guarantee.

**Files:**
- Modify: `apps/api/src/services/notificationSenders/inAppSender.ts:129`
- Test: `apps/api/src/services/notificationSenders/inAppSender.dedupe.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: in-app rows carry `dedupeKey = 'alert:' + alertId + ':' + userId`. Task 4 asserts exactly one row per (alert, user) after a double replay.

- [ ] **Step 1: Write the failing test**

```ts
it('stamps a per-user dedupe key so a replayed alert cannot duplicate the in-app row', async () => {
  await sendInAppNotifications({
    orgId: ORG, alertId: 'alert-1', alertName: 'Disk full',
    message: 'boom', severity: 'high', userIds: ['user-a', 'user-b'],
  });

  const inserted = insertValuesMock.mock.calls.at(-1)![0] as Array<{ dedupeKey?: string }>;
  expect(inserted.map((r) => r.dedupeKey)).toEqual([
    'alert:alert-1:user-a',
    'alert:alert-1:user-b',
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/notificationSenders/inAppSender.dedupe.test.ts`
Expected: FAIL — every `dedupeKey` is `undefined`; the mapped object in `inAppSender.ts:129` has no such field.

- [ ] **Step 3: Write minimal implementation**

```ts
    const notifications = Array.from(userIdSet).map(userId => ({
      userId,
      orgId: payload.orgId,
      type: 'alert' as const,
      priority: severityToPriority(payload.severity),
      title: payload.alertName,
      message: payload.message,
      link,
      metadata,
      // Durable backstop for redelivery. The partial unique index on
      // (user_id, dedupe_key) is what actually enforces this; the key must
      // therefore be per-USER, not per-alert, or two recipients of the same
      // alert would collide and only one would ever be notified.
      dedupeKey: `alert:${payload.alertId}:${userId}`,
      read: false
    }));
```

The insert must tolerate the conflict rather than throw — a redelivery is expected, not exceptional:

```ts
    await db.insert(userNotifications).values(notifications).onConflictDoNothing();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/notificationSenders/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/notificationSenders/
git commit -m "fix(api): stamp a per-user dedupe key on alert in-app notifications"
```

---

## Task 3: Unique `(webhook_id, event_id)` on webhook deliveries

`webhook_deliveries` already carries an `event_id` column (`db/schema/integrations.ts:85`) but has **no index block at all**, so nothing stops a replay creating a second delivery row and a second outbound POST to the customer's endpoint. This is the only customer-*external* duplicate in the audit, so it gets a real database constraint.

**Files:**
- Create: `apps/api/migrations/2026-09-11-a-webhook-delivery-event-uniqueness.sql`
- Modify: `apps/api/src/db/schema/integrations.ts` (`webhookDeliveries` table definition)
- Modify: `apps/api/src/workers/webhookDelivery.ts:448`
- Test: `apps/api/src/workers/webhookDelivery.dedupe.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `createDeliveryRecord` returns `null` when the `(webhook_id, event_id)` pair already exists, and the `'*'` subscriber skips `queueDelivery` for that webhook. Task 4 asserts one POST per (webhook, event).

- [ ] **Step 1: Write the failing migration + test**

`apps/api/migrations/2026-09-11-a-webhook-delivery-event-uniqueness.sql`:

```sql
-- Wave 3.5a: one delivery per (webhook, event). Without this, a redelivered
-- event creates a second delivery row and a second outbound POST to the
-- CUSTOMER's endpoint — the only externally-visible duplicate in the wave-3.5
-- idempotency audit.
--
-- Pre-existing duplicates must go before the index can be created. Report the
-- count: silently discarding delivery history destroys the forensic trail, and
-- a non-zero count here is itself evidence that redelivery already happens.
DO $$
DECLARE
  removed integer;
BEGIN
  WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY webhook_id, event_id ORDER BY created_at ASC, id ASC
    ) AS rn
    FROM webhook_deliveries
  )
  DELETE FROM webhook_deliveries wd
  USING ranked
  WHERE wd.id = ranked.id AND ranked.rn > 1;

  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed > 0 THEN
    RAISE WARNING 'wave 3.5a: removed % duplicate webhook_deliveries row(s)', removed;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_webhook_event_uq
  ON webhook_deliveries (webhook_id, event_id);
```

Test (`webhookDelivery.dedupe.test.ts`):

```ts
it('does not queue a second delivery when the (webhook, event) pair already exists', async () => {
  createDeliveryRecordMock.mockResolvedValueOnce('delivery-1').mockResolvedValueOnce(null);

  await handler(EVENT);   // first delivery
  await handler(EVENT);   // redelivery of the SAME event.id

  expect(queueDeliveryMock).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/workers/webhookDelivery.dedupe.test.ts`
Expected: FAIL — `queueDelivery` is called twice, because the subscriber queues unconditionally regardless of what `createDeliveryRecord` returned.

- [ ] **Step 3: Write minimal implementation**

Add the index to the Drizzle definition so `db:check-drift` stays clean:

```ts
export const webhookDeliveries = pgTable('webhook_deliveries', {
  // …unchanged columns…
}, (table) => ({
  webhookEventUq: uniqueIndex('webhook_deliveries_webhook_event_uq')
    .on(table.webhookId, table.eventId),
}));
```

In `webhookDelivery.ts:448`, treat a null delivery id as "already handled":

```ts
      for (const webhook of webhooks) {
        const deliveryId = createDeliveryRecord
          ? await runWithSystemDbAccess(() => createDeliveryRecord(webhook, event))
          : null;
        // A NULL id from a configured creator means the (webhook, event) pair
        // is already recorded — this is a redelivery, and the original POST
        // either went out or is still pending. Queueing again would double-POST
        // to the customer. Only the no-creator path may queue blind.
        if (createDeliveryRecord && deliveryId === null) continue;
        await worker.queueDelivery(webhook, event, deliveryId ?? undefined);
      }
```

The `createDeliveryRecord` implementation (`apps/api/src/index.ts:1387`) must return `null` on conflict:

```ts
  const [row] = await db.insert(webhookDeliveries)
    .values({ webhookId: webhook.id, eventType: event.type, eventId: event.id, payload: event.payload })
    .onConflictDoNothing({ target: [webhookDeliveries.webhookId, webhookDeliveries.eventId] })
    .returning({ id: webhookDeliveries.id });
  return row?.id ?? null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/workers/webhookDelivery && npx vitest run src/db/autoMigrate.test.ts`
Expected: PASS. `autoMigrate.test.ts` confirms the new filename sorts after every committed migration.
Then: `pnpm db:check-drift` — expected: no drift.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-09-11-a-webhook-delivery-event-uniqueness.sql apps/api/src/db/schema/integrations.ts apps/api/src/workers/webhookDelivery.ts apps/api/src/workers/webhookDelivery.dedupe.test.ts apps/api/src/index.ts
git commit -m "fix(api): one webhook delivery per (webhook, event) pair"
```

---

## Task 4: Compare-and-swap on alert resolution

`resolveAlert` (`services/alertService.ts:257`) updates by alert id with no status predicate and then publishes `alert.resolved` unconditionally. Two concurrent consumers of `policy.compliant` therefore both "resolve" the same alert and both publish — and each published `alert.resolved` cancels escalations and feeds the AI triage loop guard.

**Files:**
- Modify: `apps/api/src/services/alertService.ts` (`resolveAlert`)
- Test: `apps/api/src/services/alertService.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveAlert(alertId: string, …): Promise<boolean>` — `true` only for the caller that actually transitioned the row. Task 6's integration suite asserts exactly one `alert.resolved` publish per double replay.

- [ ] **Step 1: Write the failing test**

```ts
it('publishes alert.resolved only for the caller that actually transitioned the row', async () => {
  // First call wins: the UPDATE ... RETURNING yields the row.
  updateReturningMock.mockResolvedValueOnce([{ id: 'alert-1', orgId: ORG, deviceId: DEV }]);
  // Second call loses: status is no longer active/acknowledged, so zero rows.
  updateReturningMock.mockResolvedValueOnce([]);

  expect(await resolveAlert('alert-1')).toBe(true);
  expect(await resolveAlert('alert-1')).toBe(false);
  expect(publishEvent).toHaveBeenCalledTimes(1);
});

it('scopes the update to non-terminal statuses', async () => {
  updateReturningMock.mockResolvedValueOnce([{ id: 'alert-1', orgId: ORG, deviceId: DEV }]);
  await resolveAlert('alert-1');
  const where = compiled(updateWheresMock.mock.calls.at(-1)![0] as SQL);
  expect(where).toContain('"status"');
  expect(where).toContain('"id"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/alertService.test.ts -t 'actually transitioned'`
Expected: FAIL — `publishEvent` is called twice; the update has no status predicate and the function does not report whether it won.

- [ ] **Step 3: Write minimal implementation**

Keep the existing three-parameter signature — `resolveAlert(alertId, resolutionNote?, resolvedBy?)` — and change only the return type and the concurrency control. The current body does `SELECT` → `if (!alert) return` → blind `UPDATE … WHERE id = …`; the select is still needed for `alert.ruleId` / `alert.configPolicyId` in the `recordStateTransition` call below it, but it must no longer be what decides whether to proceed.

```ts
export async function resolveAlert(
  alertId: string,
  resolutionNote?: string,
  resolvedBy?: string
): Promise<boolean> {
  // Winner-takes-all. The status predicate IS the concurrency control: a second
  // resolver of the same alert updates zero rows and must not proceed, or the
  // resolution fan-out (state transition, escalation cancellation, AI triage
  // loop guard) runs twice for one real transition. The RETURNING row replaces
  // the previous SELECT — reading first and updating by id unconditionally is
  // the check-then-act race this task exists to remove.
  const [alert] = await db
    .update(alerts)
    .set({
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: resolvedBy ?? null,
      resolutionNote: resolutionNote ?? null
    })
    .where(and(
      eq(alerts.id, alertId),
      inArray(alerts.status, ['active', 'acknowledged', 'suppressed']),
    ))
    .returning();

  if (!alert) return false;
  // …existing recordStateTransition / publish body, unchanged, now reachable
  // only for the winner…
  return true;
}
```

Sweep every caller: any that assumed `void` must now either ignore the boolean explicitly or branch on it. Run `grep -rn 'resolveAlert(' apps/api/src | grep -v '\.test\.'` and update each site.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/alertService`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/alertService.ts apps/api/src/services/alertService.test.ts
git commit -m "fix(api): resolve alerts under a compare-and-swap so only the winner publishes"
```

---

## Task 5: Give the incident passes real marker columns

Both unsafe incident passes record their own completion **inside the `incidents.timeline` jsonb array** and gate on reading it back:

- The enricher (`incidentJobs.ts:70-85`) selects with `NOT (timeline::jsonb @> '[{"type":"timeline_enriched"}]'::jsonb)`, then appends a `timeline_enriched` entry.
- The SLA monitor (`incidentJobs.ts:142-146`) selects stale incidents, computes `alreadyEscalated = timeline.some(e => e.type === 'incident_escalated')`, then appends an `incident_escalated` entry.

There is **no `incident_escalations` table** and no marker column — `incidents` carries only `timeline jsonb NOT NULL DEFAULT []` (`db/schema/incidents.ts`). Read-array-then-append cannot be made atomic with a predicate, and `timeline` is a *rendering* surface: putting control state in it means the display format and the concurrency control are the same field. Add two real marker columns and CAS on those; keep writing the timeline entries for display.

**Files:**
- Create: `apps/api/migrations/2026-09-11-b-incident-atomic-winners.sql`
- Modify: `apps/api/src/db/schema/incidents.ts` — add `timelineEnrichedAt`, `escalatedAt`
- Modify: `apps/api/src/jobs/incidentJobs.ts` — enricher pass + SLA monitor pass
- Test: `apps/api/src/jobs/incidentJobs.atomicWinner.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `incidents.timeline_enriched_at` and `incidents.escalated_at` (both `timestamptz NULL`). Task 6's integration suite runs two passes concurrently and asserts one enrichment and one escalation.

- [ ] **Step 1: Write the migration**

```sql
-- Wave 3.5a: the incident enricher and SLA monitor both record completion by
-- appending to the `timeline` jsonb array and gate on reading it back. That is
-- check-then-act: two processes read the same un-marked array and both append.
-- Invisible today only because one process runs; the wave-3.5d role split makes
-- it real (a duplicate escalation pages on-call twice).
--
-- Marker columns give each pass something atomic to compare-and-swap on. The
-- timeline entries stay — they are what the incident UI renders.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS timeline_enriched_at timestamptz;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

-- Backfill from the existing markers so already-processed incidents are not
-- re-enriched or re-escalated the first time the new code runs. Report counts:
-- a surprising number here means the timeline markers and reality disagree.
DO $$
DECLARE
  enriched integer;
  escalated integer;
BEGIN
  UPDATE incidents SET timeline_enriched_at = updated_at
  WHERE timeline_enriched_at IS NULL
    AND timeline::jsonb @> '[{"type":"timeline_enriched"}]'::jsonb;
  GET DIAGNOSTICS enriched = ROW_COUNT;

  UPDATE incidents SET escalated_at = updated_at
  WHERE escalated_at IS NULL
    AND timeline::jsonb @> '[{"type":"incident_escalated"}]'::jsonb;
  GET DIAGNOSTICS escalated = ROW_COUNT;

  IF enriched > 0 OR escalated > 0 THEN
    RAISE WARNING 'wave 3.5a: backfilled % enriched / % escalated incident marker(s)', enriched, escalated;
  END IF;
END $$;

-- Partial indexes: both passes scan for the NULL side only.
CREATE INDEX IF NOT EXISTS incidents_timeline_unenriched_idx
  ON incidents (id) WHERE timeline_enriched_at IS NULL;
CREATE INDEX IF NOT EXISTS incidents_unescalated_idx
  ON incidents (id) WHERE escalated_at IS NULL;
```

Add both columns to the Drizzle definition so `db:check-drift` stays clean:

```ts
  timelineEnrichedAt: timestamp('timeline_enriched_at', { withTimezone: true }),
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
```

- [ ] **Step 2: Write the failing tests**

```ts
it('claims incidents for enrichment in the statement that selects them', async () => {
  await runIncidentTimelineEnrichmentPass();
  const where = compiled(updateWheresMock.mock.calls.at(-1)![0] as SQL);
  expect(where).toContain('"timeline_enriched_at"');
});

it('escalates an incident only when it won the compare-and-swap', async () => {
  updateReturningMock.mockResolvedValueOnce([{ id: 'inc-1', orgId: ORG, severity: 'p1' }]);
  updateReturningMock.mockResolvedValueOnce([]);   // lost the CAS

  await runIncidentSlaMonitorPass();
  await runIncidentSlaMonitorPass();

  expect(publishEvent).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/jobs/incidentJobs.atomicWinner.test.ts`
Expected: FAIL — the enricher's update keys only on `id`, and the SLA pass publishes on both runs because `alreadyEscalated` is derived from the array it just read.

- [ ] **Step 4: Write minimal implementation**

Enricher — claim, then work:

```ts
    // Claim-then-work. `FOR UPDATE SKIP LOCKED` is the established idiom here
    // (jobs/oauthRevocationRetryWorker.ts:18).
    const claimed = await db
      .update(incidents)
      .set({ timelineEnrichedAt: new Date() })
      .where(inArray(incidents.id,
        db.select({ id: incidents.id })
          .from(incidents)
          .where(and(ne(incidents.status, 'closed'), isNull(incidents.timelineEnrichedAt)))
          .limit(100)
          .for('update', { skipLocked: true }),
      ))
      .returning({ id: incidents.id, status: incidents.status, timeline: incidents.timeline });

    // …existing timeline-append loop, now over `claimed` instead of `rows`…
```

SLA monitor — CAS per incident, publish only for the winner:

```ts
    for (const row of staleIncidents) {
      // The UPDATE is the lock. `alreadyEscalated` computed from the array we
      // just read is per-process belief, not a fact.
      const [won] = await db
        .update(incidents)
        .set({ escalatedAt: new Date() })
        .where(and(eq(incidents.id, row.id), isNull(incidents.escalatedAt)))
        .returning({ id: incidents.id });
      if (!won) continue;

      // …existing timeline append + publish, now reachable only for the winner…
    }
```

- [ ] **Step 5: Register both new columns in the export policy — do NOT skip**

`incidents` is an org-cascade table (`services/tenantCascade.ts:217`) whose export-policy entry enumerates every column (`services/tenantExportPolicyRegistry.ts:179`). Add `timeline_enriched_at` and `escalated_at` to that entry's `included` array, immediately after `closed_at`:

```ts
  "incidents": tablePolicy("org_id", {"included":["id","org_id","title","classification","severity","status","summary","source_type","source_ref","assigned_to","detected_at","contained_at","resolved_at","closed_at","timeline_enriched_at","escalated_at","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["related_alerts","affected_devices","affected_users","timeline"]}),
```

Both are plain timestamps — ordinary customer data, no suspicious name part, not an open `json`/`jsonb`/`bytea` container — so `included` is correct.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/jobs/incidentJobs && npx vitest run src/db/autoMigrate.test.ts`
Then: `pnpm db:check-drift`
Then, with a live database: `pnpm --filter @breeze/api test:integration src/__tests__/integration/tenant-export-policy.integration.test.ts`
Expected: PASS, no drift. The export-policy suite is the one that catches a missed column, and it **cannot** fail in the Test API job — run it locally or the PR goes green and reds main.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-09-11-b-incident-atomic-winners.sql apps/api/src/db/schema/incidents.ts apps/api/src/jobs/incidentJobs.ts apps/api/src/jobs/incidentJobs.atomicWinner.test.ts apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "fix(api): compare-and-swap incident enrichment and SLA escalation on marker columns"
```

---

## Task 6: The barrier — a real-Postgres redelivery suite

Every task above is pinned by mock-based unit tests. Mocks cannot prove a unique index exists, that a CAS predicate actually filters, or that `onConflictDoNothing` targets the right index — and this repo has shipped compiled-SQL assertions that were *correct* while only real Postgres caught the bug. This suite is the wave's actual gate.

**Files:**
- Create: `apps/api/src/__tests__/integration/eventRedeliveryIdempotency.integration.test.ts`

**Interfaces:**
- Consumes: `dispatchAlertNotifications` (Task 1), `dedupeKey` on in-app rows (Task 2), `createDeliveryRecord` (Task 3), `resolveAlert` (Task 4), the incident passes (Task 5).
- Produces: the regression barrier for waves 3.5b–3.5d.

- [ ] **Step 1: Write the failing test**

```ts
describe('event redelivery is idempotent against real Postgres', () => {
  it('one alert.triggered delivered twice yields one in-app row per user', async () => {
    const t = await seedTenant();
    const alertId = await seedAlert(t);

    await sendInAppNotifications({ orgId: t.orgId, alertId, userIds: [t.userId], /* … */ });
    await sendInAppNotifications({ orgId: t.orgId, alertId, userIds: [t.userId], /* … */ });

    const rows = await db.select().from(userNotifications)
      .where(and(eq(userNotifications.userId, t.userId), eq(userNotifications.orgId, t.orgId)));
    expect(rows).toHaveLength(1);
  });

  it('one event delivered twice yields one webhook_deliveries row per webhook', async () => {
    const t = await seedTenant();
    const webhookId = await seedWebhook(t);
    const eventId = randomUUID();

    expect(await createDeliveryRecord({ id: webhookId }, { id: eventId, /* … */ })).not.toBeNull();
    expect(await createDeliveryRecord({ id: webhookId }, { id: eventId, /* … */ })).toBeNull();

    const rows = await db.select().from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.webhookId, webhookId), eq(webhookDeliveries.eventId, eventId)));
    expect(rows).toHaveLength(1);
  });

  it('two concurrent resolvers transition the alert once', async () => {
    const t = await seedTenant();
    const alertId = await seedAlert(t);

    const [a, b] = await Promise.all([resolveAlert(alertId), resolveAlert(alertId)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('two concurrent SLA passes escalate an incident once', async () => {
    const t = await seedTenant();
    const incidentId = await seedBreachedIncident(t);

    await Promise.all([runIncidentSlaMonitorPass(), runIncidentSlaMonitorPass()]);

    const [row] = await db.select({ escalatedAt: incidents.escalatedAt })
      .from(incidents).where(eq(incidents.id, incidentId));
    expect(row.escalatedAt).not.toBeNull();
    expect(publishEventSpy.mock.calls.filter(([t]) => t === 'incident.escalated')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the suite and confirm each case fails for the right reason**

Run: `pnpm --filter @breeze/api test:integration src/__tests__/integration/eventRedeliveryIdempotency.integration.test.ts`

Note the **absence of `--`** — `test:integration -- <path>` silently runs the whole suite instead of the file.
Expected before Tasks 1–5: every case FAILS with 2 rows / 2 winners. Confirm the file actually **ran** — check the reported test count, since a misplaced integration file is collected by zero CI jobs and reads as green.

- [ ] **Step 3: Confirm the suite passes with Tasks 1–5 applied**

Run the same command.
Expected: PASS, 4/4.

- [ ] **Step 4: Prove each assertion discriminates**

For each of the four cases, revert its fix (drop the unique index, or remove the status predicate), re-run, and confirm that case alone fails. A test that passes with the fix reverted is vacuous and must be rewritten.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/eventRedeliveryIdempotency.integration.test.ts
git commit -m "test(api): pin event-redelivery idempotency against real Postgres"
```

---

## Task 7: Gate the AI agent runner on the kill switch (closes #3977)

Verified live in production 2026-08-26: both EU and US boot `[AiAgentRunner] AI agent runner initialized` with `BREEZE_AI_AGENTS_ENABLED` unset **and unmapped in each droplet's compose**, so each region permanently holds a blocking Redis connection for a disabled feature. `initializeAiAgentRunner` (`jobs/aiAgentRunner.ts`) constructs the BullMQ `Worker` unconditionally.

**Files:**
- Modify: `apps/api/src/index.ts:1431`
- Test: `apps/api/src/jobs/aiAgentRunner.test.ts`

**Interfaces:**
- Consumes: `AI_AGENTS_ENABLED` from `config/env.ts:98`.
- Produces: no worker, no Redis connection, when the flag is off. The module-scope enqueuer registration is untouched — the manual-trigger route still enqueues, exactly as `aiAgentRunner.ts:23-29` documents.

- [ ] **Step 1: Write the failing test**

```ts
it('does not construct the BullMQ worker when the platform kill switch is off', async () => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');
  initializeAiAgentRunner();
  expect(WorkerCtor).not.toHaveBeenCalled();
});

it('still constructs the worker when the switch is on', async () => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  initializeAiAgentRunner();
  expect(WorkerCtor).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/jobs/aiAgentRunner.test.ts -t 'kill switch'`
Expected: FAIL — the worker is constructed regardless of the flag.

- [ ] **Step 3: Write minimal implementation**

Gate at the registration site in `index.ts:1431`, matching the existing `MCP_OAUTH_ENABLED` precedent at `index.ts:652`:

```ts
    // initializeAiAgentRunner is synchronous (returns void), so wrap it.
    // Gated: the worker opens a BLOCKING Redis connection, so booting it with
    // the platform kill switch off costs a permanent connection per process
    // for a feature that can never run (#3977). The enqueuer is registered at
    // module scope, not here, so the manual-trigger route is unaffected.
    ...(AI_AGENTS_ENABLED
      ? [['aiAgentRunner', async () => { initializeAiAgentRunner(); }] as const]
      : []),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/jobs/aiAgentRunner && npx vitest run src/index`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/index.ts apps/api/src/jobs/aiAgentRunner.test.ts
git commit -m "fix(api): gate the ai-agent worker on BREEZE_AI_AGENTS_ENABLED

Closes #3977"
```

---

## Task 8: Drop the redundant partial index (closes #3979)

**Files:**
- Create: `apps/api/migrations/2026-09-11-c-drop-redundant-managed-agent-index.sql`
- Modify: `apps/api/src/db/schema/automations.ts` if the index is declared there

- [ ] **Step 1: Confirm the redundancy before writing anything**

Run:
```bash
grep -rn 'managed_by_agent' apps/api/migrations/2026-09-08-managed-by-agent.sql
```
Confirm both the partial unique index `automations_managed_by_agent_uq` and the plain partial index exist, and that the unique one fully covers the plain one's column list. If it does not, **stop** — the issue's premise is wrong and #3979 should be corrected instead.

- [ ] **Step 2: Write the migration**

```sql
-- Wave 3.5a (#3979): the plain partial index on automations.managed_by_agent_id
-- is fully covered by the partial UNIQUE index automations_managed_by_agent_uq
-- created in the same migration (2026-09-08-managed-by-agent.sql). Forward-only
-- drop; the unique index continues to serve every lookup on that column.
DROP INDEX IF EXISTS automations_managed_by_agent_id_idx;
```

- [ ] **Step 3: Verify no drift and the ordering holds**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts` then `pnpm db:check-drift`
Expected: PASS, no drift.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-09-11-c-drop-redundant-managed-agent-index.sql apps/api/src/db/schema/automations.ts
git commit -m "perf(api): drop the redundant partial index on automations.managed_by_agent_id

Closes #3979"
```

---

## Pre-PR checklist

- [ ] `cd apps/api && npx vitest run` — full API unit suite green
- [ ] `pnpm --filter @breeze/api test:integration` — full integration suite green (**no `--`**)
- [ ] `pnpm --filter @breeze/api test:rls` — RLS contract suite green (schema changed)
- [ ] `incidents` export-policy entry lists `timeline_enriched_at` and `escalated_at` (Task 5 Step 5)
- [ ] `pnpm db:check-drift` — no drift
- [ ] `scripts/check-migration-naming.sh` — all three new migrations sort after `2026-09-10-…`
- [ ] Each of Task 6's four cases proven to fail with its own fix reverted
- [ ] PR body carries `Closes #3977`, `Closes #3979`, and `Refs #3825` — **not** `Closes #3825`, since 3.5b–3.5d remain

## What this wave deliberately does NOT do

- **No `BREEZE_ROLE`, no worker container, no compose change.** Wave 3.5d.
- **No change to how events are delivered.** Handlers keep their `try/catch`; `invokeLocalHandlers` still swallows. Wave 3.5c.
- **No socket-affinity fix.** Wave 3.5b, and it blocks 3.5d.
- **No `plugins.ts:808` hardening.** `initPluginEventBridge()` has no production caller; it needs the full event envelope (it currently drops it at `plugins.ts:951`) and `(plugin_id, hook, event_id)` receipts before activation. Track separately — activating it is a product decision, not a wave-3.5 one.
