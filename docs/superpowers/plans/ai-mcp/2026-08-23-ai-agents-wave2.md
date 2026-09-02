---
date: 2026-08-23
feature: AI Agents (#3821)
wave: W02 (#3823)
tracking_issue: LanternOps/breeze#3821
spec: docs/superpowers/specs/ai-mcp/2026-08-22-ai-agents-program-and-wave1-design.md
branch: feature/3821-ai-agents/wave-3823
---

# AI Agents wave 2 — in-app notifications + web approvals inbox

## 0. Reality check — the spec's framing is stale

This was written after mapping the actual code. **Four of the spec's wave-2
assumptions are wrong**, and building to the spec verbatim would have produced a
parallel notification system alongside the one that already ships.

| Spec says | Reality (verified) |
|---|---|
| build `createNotification()` and an in-app notification system | `user_notifications` **already exists** (`db/schema/notifications.ts:33-50`) with full CRUD (`routes/notifications.ts`), a bell UI (`components/layout/NotificationCenter.tsx`), and both tenancy registries already satisfied. No new table. |
| build a `/approvals` API over `routes/approvals.ts` | The `/approvals` alias is **already mounted** (`index.ts:1074`), added explicitly so "a web/CLI caller doesn't need the `/mobile` prefix". The approvals server side is **done**; wave 2 is a frontend job there. |
| "per-user real-time delivery" | `EventDispatcher` is **org-broadcast**. `ClientEntry.userId` exists but is used only in `console.warn` (`eventDispatcher.ts:131,140`). Today's delivery is a **30-second poll** (`NotificationCenter.tsx:14`). |
| "requester outcome notifications via the intent outbox" | `intent_outbox.event_type` is CHECK-constrained to `intent_created|intent_approved` (`2026-07-18-action-intents.sql:155`). **A denied intent writes no outbox row at all.** This is a migration + new producers + a new consumer, not a subscription. |

The spec's `isRequester` pointer (`approvals.ts:757`) is also wrong: `isRequester`
lives in `services/actionIntents/intentService.ts:777` and gates **cancel**, not
decide. The real decide gates are `approvals.ts:1135` (supervised identity →
`not_requester`) and `:1207-1233` (four-eyes live permission re-check).

### The bug this wave actually fixes

Four-eyes approvers are notified **only by mobile push**
(`intentService.ts:658-673` → `expoPush.ts`), and `getUserPushTokens` reads
`mobile_devices` exclusively. **An approver with no enrolled phone is notified by
nothing** — no in-app row, no email, no WS event — and the push is best-effort,
swallowing failures to `console.error` with a 60-second TTL.

## 1. Scope

Extend, don't rebuild. Seven tasks, each independently committable and green.

**In scope:** `approval`/`ai` notification types; a generic `createNotification()`;
per-user real-time targeting; in-app notification on four-eyes fan-out; requester
outcome notifications through the outbox; the `/approvals` web inbox; the
notification-type drift fix.

**Out of scope (deliberate):** publishing `ai.agent.run.*` events (reserved for
wave 3, `eventBus.ts:112-118` — publishing them here is a cross-wave collision);
notification retention/expiry policy (noted in §6); email as a notification
channel.

## 2. Two decisions that deviate from the spec, and why

### 2.1 `user_notifications` RLS is hardened to dual-axis (user AND org)

Today all four policies are **org-only** — `USING (breeze_has_org_access(org_id))`
(`0001-baseline.sql:16121, 16982, 17843, 18704`), with no `user_id` predicate,
and nothing since baseline changes them. Cross-user isolation inside one org
rests **entirely on route predicates**. All five routes do currently carry
`eq(userNotifications.userId, auth.user.id)` — verified — so this is not a live
exploit. It is app-layer-only tenancy, which CLAUDE.md forbids outright, on the
table this wave is about to fill with approval action labels and risk summaries.

New policy (single `FOR ALL`, replacing the four):

```
system  OR  (user_id = breeze_current_user_id()
             AND (org_id IS NULL OR breeze_has_org_access(org_id)))
```

This is **strictly narrower** than today for user traffic and identical for the
system path, so no correct caller changes behaviour. Two things make it safe,
both verified rather than assumed:

- Only two files insert into this table — `notificationSenders/inAppSender.ts`
  and `jobs/ticketNotifyWorker.ts`. Both fan out rows for *other* users, and both
  run under a **system** context (`notificationDispatcher.ts:107` wraps
  `processAlertNotifications` in `runWithSystemDbAccess`; the ticket worker
  mirrors that pattern at `:45-49`). The `system` branch covers them.
- The `org_id IS NULL` branch is required, not cosmetic:
  `breeze_has_org_access(NULL)` returns **FALSE** outside system scope
  (`0001-baseline.sql:1667`). Without it, a null-org notification would be
  **invisible to its own recipient** — which is exactly what the one
  reusable-looking helper does today (`inAppSender.ts:187`, `orgId || null`).

`user_notifications` moves into `USER_ID_SCOPED_TABLES` in the RLS-coverage
allowlist. It is already in `CORE_ORG_CASCADE_DELETE_ORDER:384` and
`CORE_TENANT_EXPORT_POLICY:342`; the new `dedupe_key` column must be added to the
latter or the export-policy contract test fails.

### 2.2 Per-user targeting rides the existing filter seam, not a new transport

`ClientEntry.filter` (`eventDispatcher.ts:35`) is already a generic per-client
predicate, fail-closed on throw, currently used for site scoping
(`eventWs.ts:810`). Wave 2 composes an audience check into it. **It must AND with
the existing `buildSiteFilter`, never replace it** — the ticket also carries
`allowedSiteIds`.

A targeted event must **not** reach the org-wide channel, the Redis stream, or
local wildcard handlers (`eventBus.ts:285-308`); otherwise "targeted" leaks to
every tab in the org. This is the single highest-risk item in the wave and gets
its own behavioural test.

## 3. Tasks

Each task ends green. Migration filename `2026-09-04-ai-agent-notifications.sql`
sorts after main's `2026-09-03-ai-agents-permissions.sql`.

**PG16 constraint:** `autoMigrate` wraps every file in one transaction. `ALTER
TYPE … ADD VALUE` is legal there on PG12+, but the new value **cannot be used in
the same transaction**. The migration therefore only *adds* the enum values — no
INSERT or UPDATE in that file may reference `'ai'` or `'approval'`.

### Task 1 — Schema: enum values, dedupe key, RLS hardening, outbox events
Migration + `db/schema/notifications.ts` + `db/schema/actionIntents.ts` +
`rls-coverage.integration.test.ts` (`USER_ID_SCOPED_TABLES`) +
`tenantExportPolicyRegistry.ts` (`dedupe_key` → `included`) + a new
`userNotificationsRls.integration.test.ts`.

- `ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'approval'` / `'ai'`.
- `dedupe_key TEXT` + partial unique `(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL`
  — makes outbox redelivery idempotent (the publisher marks published on *enqueue*,
  not on completion: `intentOutboxPublisher.ts:214-253`).
- Replace the four org-only policies with the dual-axis policy from §2.1.
- Relax `intent_outbox_event_type_check` to add `intent_rejected`, `intent_expired`.
- RLS test must prove: same-user read OK; **same-org different-user denied**
  (this is the new property); inaccessible-org denied; system context OK;
  `org_id IS NULL` row visible to its owner.

### Task 2 — `createNotification()` + per-user event targeting
New `services/userNotifications.ts`; `eventBus.ts` (+ `eventBus.types.test.ts`);
`eventDispatcher.ts`; `eventWs.ts`.

- `createNotification({ userId, orgId, type, priority, title, message, link, metadata, dedupeKey })`
  — generic, **`orgId` required** (see §2.1), `ON CONFLICT DO NOTHING` on the
  dedupe index. Not a refactor of `sendInAppNotificationToUsers`
  (`inAppSender.ts:165`), which is dead, alert-shaped and nulls `orgId`; leave it
  alone or delete it, do not build on it.
- Add `notification.created` to the `EventType` union with an `audienceUserId`,
  and compose the audience check into `eventWs.ts:810`'s filter, ANDed with
  `buildSiteFilter`.
- Test the leak case explicitly: user A's targeted event must not reach user B's
  client in the same org, including the wildcard-subscriber path.

### Task 3 — Notify approvers in-app on four-eyes fan-out
`services/actionIntents/intentService.ts` around `:658-673`.

Alongside the existing push (do not replace it — mobile must keep working), write
a `type:'approval'` notification per fanned-out approver, with
`link: '/approvals'` and `dedupeKey: 'intent-approval:<intentId>:<userId>'`.
Keep it inside the existing best-effort try/catch shape so a notification failure
can never fail intent creation — but log it with context rather than a bare
message. Supervised intents still notify nobody (`:655-657`): the requester is
watching the chat stream, and that is deliberate.

### Task 4 — Requester outcome notifications through the outbox
`routes/approvals.ts` (deny path), `jobs/intentExpiryReaper.ts`,
`jobs/intentReleaseWorker.ts`, `db/schema/actionIntents.ts`.

- Write `intent_rejected` on deny (today **nothing** is written) and
  `intent_expired` in the reaper (today it mutates rows with no outbox record).
- Extend the consumer, which currently ignores everything but `intent_approved`
  (`intentReleaseWorker.ts:618-632`), to write a requester notification.
- **Re-read intent status at delivery time.** `intent_created` can be processed
  after the intent was already decided; emit nothing if it is no longer
  `pending_approval`.
- Copy must say *authorization succeeded*, not *the action succeeded* — approval
  releases execution, it does not complete it.

### Task 5 — Fix the notification-type drift, make the bell real-time
`routes/notifications.ts:20` (zod enum omits `'ticket'` today —
you cannot filter for the type the ticket worker writes);
`components/layout/NotificationCenter.tsx:16,61-67,73-78,92-105`.

`getNotificationType()` silently coerces anything unknown to `'system'`, and
`buildHref` then deep-links it to `/settings/organization`. Adding types without
fixing all three copies ships notifications that render mislabelled and navigate
to the wrong page. Derive the type list from one shared constant instead of a
fourth hand-maintained copy. Subscribe via `useEventStream` and reconcile with
the existing 30s poll (keep the poll as the reconnect/missed-while-offline path).

### Task 6 — `/approvals` web inbox
New `pages/approvals.astro` + `components/approvals/ApprovalsInbox.tsx`;
`Sidebar.tsx`; `lib/routeScope.ts` (the route is absent from the scope registry).

Zero new API endpoints. Consumes `GET /approvals/pending`, `/pending/count`,
`/:id`, and decides through the **existing** `lib/intentApprovals.ts`, which
already wraps the WebAuthn ceremony and carries the three error remedies
(`isNoApproverDeviceError`, `isStepUpRequired`, `isNotSoleApprover`). Pending
count drives a sidebar badge.

`approval_requests` has **no `org_id`** (Shape 6, `approvals.ts` schema) — any
org label or filter must join `action_intents` under a **system** context via
`runOutsideDbContext(withSystemDbAccessContext(...))`; a plain nested call is a
silent no-op passthrough.

### Task 7 — i18n across all eight catalogs
`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`. Genuine
translations — `translationCoverage.test.ts` caps exact-English duplicates per
namespace, and `localeParity.test.ts` checks key parity and interpolation tokens.
Dynamic `t()` keys need `/* i18n-dynamic */`.

## 4. Verification

Per task: targeted unit tests + `tsc --noEmit`. Before the PR, the full set from
wave 1 — API unit, web, shared, the integration contract suites, `rls-coverage`,
`rls`, `pnpm lint`, `astro check` — plus the new
`userNotificationsRls.integration.test.ts`. Recreate the test stack whenever the
migration changes (`pnpm test-stack down && pnpm test-stack up`).

Mutation-test the security-relevant assertions: revert the fix, confirm red.

## 5. Risks

- **Cross-user event leak** — the highest-risk item; §2.2.
- **Breaking live alert/ticket notifications** via the RLS change — mitigated by
  the system branch; both producers verified.
- **Breaking the mobile approval path** — push stays exactly as it is; the
  in-app row is additive.
- **Stale pending notifications** — outbox rows outlive the decision; re-read
  status at delivery (Task 4).
- **Demoted approvers** — recipients must be revalidated at delivery time;
  creation-time fan-out is not enduring authority, the same principle
  `approvals.ts:154-181` already applies on read.
- **Secrets** — never surface raw intent `arguments`/`result` in a notification
  or the inbox; both are `excludedOpen` in the export policy for that reason.

## 6. Deliberately deferred

Notification retention/dedupe-expiry: nothing prunes `user_notifications` today,
and a four-eyes fan-out to N approvers writes N rows that persist after the
intent is decided. Wave 2 adds `dedupe_key` (which bounds duplicates) but no
retention job. Worth a follow-up before the fleet grows.
