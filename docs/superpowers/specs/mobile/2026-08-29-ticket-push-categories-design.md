---
tracking_issue: LanternOps/breeze#3206
wave: W07
wave_issue: LanternOps/breeze#3901
---

# Ticket Push Categories: Assignment and SLA Breach (Mobile) — Design Spec

**Date:** 2026-08-29
**Wave:** W07 (`LanternOps/breeze#3901`) of parent feature `#3206` "Ticketing and time entry in the mobile app".
**Status:** Drafted — awaiting plan. Depends on W01 (Tickets tab + `TicketDetail` screen, shipped) and on the approval push pipeline (`expoPush.ts` / `apns.ts`, live).
**Evidence labels:** [verified] = read at the cited path in this worktree on 2026-08-29; [inferred] = design conclusion; [not-checked] = not inspected, confirm during implementation.

## Goal

A technician gets a phone push when a ticket is assigned to them, and when a ticket they own (or, by opt-in, any ticket in their partner) breaches its response or resolution SLA. Tapping the push opens `TicketDetail` for that ticket, warm or cold start. Pushes are idempotent across BullMQ retries, tenant-bounded even though the worker runs in a system DB context, lock-screen-safe, and governed by a per-user preference that defaults to the narrow behaviour.

## Non-goals

- Android/FCM delivery. The server logs-and-skips FCM tokens [verified `apps/api/src/services/expoPush.ts:276-279`] and the app returns `unsupported` on Android [verified `apps/mobile/src/services/notifications.ts`]. Only the zero-cost `channelId: 'tickets'` string and the client parser ship.
- Partner-wide notification policy or a partner kill switch (owner principle: partner settings default off; preference here is personal).
- Email or web notification categories. The table shape leaves room (D3) but W07 exposes push only.
- Notification action buttons (APNs `category` is emitted but no `UNNotificationCategory` is registered client-side).
- A `breeze://` URL scheme / `linking` config. No consumer exists; `navigationRef` is sufficient (D9).
- Badge count changes. The badge stays owned by `reconcileApprovalNotifications` [verified `notifications.ts` end of file].
- `push_notifications` audit rows (D7).
- Partner-wide defaults for the preference. Nothing here touches `partners.settings`.

## Decisions

**D1. Fan-out lives in `jobs/ticketNotifyWorker.ts`, not `notificationDispatcher`.**
`ticketNotifyWorker` is the sole BullMQ consumer of `ticket-events` [verified `ticketNotifyWorker.ts:468-490`], already handles `ticket.created`/`ticket.assigned`/`ticket.sla_breached` [verified `:331-346`], and already has the "collect inside `runWithSystemDbAccess`, send after it exits" split for email [verified `:45-53`, `:422-463`] that #1105 requires for any network I/O. `ticket.assigned` is not an eventBus type and the dispatcher models alert channels, not per-user recipients [inferred from `ticketEvents.ts` + dispatcher shape]. A second consumer on the same queue would compete for jobs, not broadcast.
*Rejected:* a dispatcher channel kind — would need a new event type, a new channel kind, and would still have to duplicate the recipient rules the worker already owns.

**D2. Idempotency anchor is `user_notifications.dedupe_key` via `createNotification()`.**
`createNotification` does a targeted `onConflictDoNothing` on the partial unique index `(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL` and returns `null` on replay [verified `services/userNotifications.ts:76-93`, `schema/notifications.ts:64-66`]. The worker replaces its two raw `db.insert(userNotifications)` calls [verified `:105-113`, `:303-313`] with `createNotification({..., dedupeKey})` and collects a push (and email) only when a row was inserted. A `TicketEventEnvelope.eventId` (uuid) is stamped inside `emitTicketEvent` so no emitter changes; the input type makes it optional, the consumed type required, and the worker falls back to `job.id` for events already queued at deploy time. `eventId` is NOT used as the BullMQ `jobId` — that would change queue dedupe semantics for every ticket event type, which is out of W07's blast radius.
Keys: assignment `ticket:<ticketId>:assigned:<assigneeId>:<eventId>` (A→B→A re-pushes; a retry does not); SLA `ticket:<ticketId>:sla:<target>:<userId>` (the SLA worker stamps one-shot per (ticket, target) [verified `ticketSlaWorker.ts:11-22`, `:77-87`]).
Consequence: at-most-once push. A crash between insert and send loses the push; the in-app row is the durable record. Same trade as the approval path.
*Rejected:* Redis window (not durable across Redis restarts, and Redis is already the fail-open throttle); `apns-collapse-id` only (presentation-level, still sends twice).

**D3. Preferences live in a new typed Shape-6 table `ticket_push_preferences`.**
Columns `user_id PK`, `assigned_enabled boolean DEFAULT true`, `sla_scope ticket_sla_push_scope DEFAULT 'owned'` (`'off' | 'owned' | 'any'`). The `sla_scope = 'any'` branch drives a partner-wide fan-out query; it must be indexable and validated at the schema. `users.preferences` is an unvalidated jsonb shallow-merged by `PATCH /users/me` [verified `routes/users.ts:507-540`] and classified `excludedOpen` [verified `tenantExportPolicyRegistry.ts:370`] — querying `preferences->'mobilePush'->>'ticketSlaBreached' = 'all'` per SLA event is the "works now, retrofit later" shape the repo has paid for (#1724, #2126–#2129). `mobile_devices` columns are per-phone [verified `schema/mobile.ts:9-34`] so two phones would drift. Typed columns beat the generic `(user_id, channel, category, enabled)` row model because the SLA scope is a three-valued enum, not a boolean, and a generic model needs a CHECK bump per new category anyway. Adding an email/web matrix later is `ALTER TABLE ADD COLUMN` on a user-scoped table with no export-policy entry (no `org_id`), which is cheap.
*Rejected:* `users.preferences.mobilePush` (mvp-first); generic `user_notification_preferences` (risk-first).

**D4. Migration is `2026-09-23-ticket-push-preferences.sql`.**
Newest shipped migration is `2026-09-22-ai-alert-verdicts-live-unique.sql` [verified `ls apps/api/migrations | tail`]. A `2026-08-29-` filename would sort before ~25 shipped files and replay out of order on a fresh DB; `breeze_migrations` keys on filename so this cannot be fixed by rename. Date must be >= 2026-09-23 at authoring time — re-check `ls | tail` on the day the PR opens and bump if needed.

**D5. Every recipient is re-authorised inside the system context; the assignee is partner-asserted first.**
The worker runs in `withSystemDbAccessContext` (RLS bypass) and today resolves the assignee by id alone [verified `:93-104`]. New order per candidate: (1) `user.partner_id === event.partnerId` else terminal skip + `console.warn` + `captureException` (cheap, covers the assigned path — graft from risk-first); (2) `user.status = 'active'` [verified enum `users.ts:15,38`]; (3) `getUserPermissions(userId, { partnerId, orgId })` then `hasPermission(TICKETS_READ)` and `canAccessOrg(perms, event.orgId)` [verified exports `permissions.ts:88, 210, 230`]. The `'any'` set is `SELECT p.user_id FROM ticket_push_preferences p JOIN users u ON u.id = p.user_id WHERE p.sla_scope = 'any' AND u.partner_id = $partnerId AND u.status = 'active' ORDER BY u.id LIMIT 500`, with a warning on overflow. The system context is discovery only, never authority.
*Rejected:* permission gate only on the `'any'` branch (mvp-first) — the assigned path would inherit today's id-only lookup.

**D6. Throttle applies to every push, never to in-app rows.**
`checkNotificationThrottle('mobile-ticket', 'user:<userId>', 20, 300)` [verified signature `notificationThrottle.ts:40-58`, fail-open on Redis loss] before collecting tokens for any recipient, assignee included — bulk reassignment is the realistic spam case (graft from mvp-first). Throttled pushes are logged with the count; the in-app row and email are unaffected.
*Rejected:* throttling only the `'any'` branch (codex-design original).

**D7. No `push_notifications` audit rows in W07.**
The live approval path does not write them [verified `expoPush.ts:216-284` writes nothing]; adding them means a second system context after send and a second per-device bookkeeping surface. Dispatch results are logged. Revisit if delivery analytics are wanted; it needs no schema change.

**D8. Short-circuit on `isApnsConfigured()` before any token reads.**
[verified `apns.ts:73`]. Self-hosted stacks without APNs skip the whole push phase with one `info` log per process (module-level `warnedOnce`), not per event. In-app + email still run.

**D9. Mobile deep link = module-level `navigationRef` + sibling `PushTapRouter`; `ApprovalGate` untouched.**
`RootNavigator` has no `ref` or `linking` today [verified `RootNavigator.tsx:300-312`]. `ApprovalGate` owns the approval listeners and ignores non-approval data [verified `ApprovalGate.tsx:51-80`]; expo-notifications subscriptions are independently removable, so a second type-filtered listener coexists safely. `PushTapRouter` mounts next to `ApprovalGate`, handles only `data.type === 'ticket'`, and never touches approval hydration/focus. Cold start via `getLastNotificationResponseAsync` guarded by a handled-identifier (memory + AsyncStorage `notif:lastHandledResponseId`). The single-owner `NotificationRouter` refactor is a follow-up only if double-listener problems actually appear.
*Rejected:* moving approval listeners into a new router (codex-design original) — refactors the only working push path for no W07 benefit.

**D10. Preference API is on the core user route, not `/api/v1/mobile/*`.**
`GET/PATCH /api/v1/users/me/ticket-push-preferences` — per-user, self-only, callable from web later without a second endpoint (graft from risk-first). Mobile calls it through `coreRequest` [verified `apps/mobile/src/services/api.ts:372`].

**D11. Lock-screen body never contains the ticket subject.**
`sla_breached` payload carries free-text `subject` [verified `ticketEvents.ts:35`] but #3828 dropped it from `ticket.assigned` for exactly this reason [verified comment `ticketEvents.ts:20-23`], and the approval push is lock-screen-safe by design. Body is `<internalNumber> · <org name>`; the subject loads after authenticated navigation.

**D12. Quiet hours honoured (drop, never defer) for both categories.**
`mobile_devices.quiet_hours` exists [verified `schema/mobile.ts:20`] and a pure `isInQuietHours` exists [verified `services/notifications.ts:220`]. Move it to `services/quietHours.ts` so the dead Firebase module is not imported. The app has no UI to set quiet hours today, so this is forward-compatible only; a quiet-hours UI is out of scope.

**D13. Defaults: `assigned_enabled = true`, `sla_scope = 'owned'`.** Missing row = defaults, computed by one total function `resolveTicketPushPrefs(row | null)` in `packages/shared` so app and API agree without a round-trip (graft from mvp-first). `'any'` is opt-in only.

## Data model

### `ticket_push_preferences` (new, Shape 6, user-scoped)

```sql
-- apps/api/migrations/2026-09-23-ticket-push-preferences.sql (idempotent; no inner BEGIN/COMMIT)
DO $$ BEGIN
  CREATE TYPE ticket_sla_push_scope AS ENUM ('off', 'owned', 'any');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS ticket_push_preferences (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  assigned_enabled boolean NOT NULL DEFAULT true,
  sla_scope        ticket_sla_push_scope NOT NULL DEFAULT 'owned',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ticket_push_preferences_sla_any_idx
  ON ticket_push_preferences (user_id) WHERE sla_scope = 'any';

ALTER TABLE ticket_push_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_push_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_push_preferences_user_isolation ON ticket_push_preferences;
CREATE POLICY ticket_push_preferences_user_isolation ON ticket_push_preferences
  FOR ALL
  USING      (public.breeze_current_scope() = 'system' OR user_id = public.breeze_current_user_id())
  WITH CHECK (public.breeze_current_scope() = 'system' OR user_id = public.breeze_current_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_push_preferences TO breeze_app;
```

- Policy spelling copied from `user_notifications` [verified `2026-09-04-ai-agent-notifications.sql:60-72`]. The `system` branch is required because the notify worker reads this table inside `withSystemDbAccessContext`. Unlike `mobile_devices`/`push_notifications` [verified `2026-04-11-bucket-c-phase-6-user-scoped-rls.sql:100-137`] no partner/org admin branch is ORed in: nobody but the user and system jobs needs a push preference.
- Not a Partner-Wide-First config table: it has no `org_id`/`partner_id` because it is a personal preference (same category as `mobile_devices`), which is the explicit justification the CLAUDE.md contract asks for.
- Drizzle: `apps/api/src/db/schema/ticketPushPreferences.ts` (pgEnum + pgTable), exported from `db/schema/index.ts`; `pnpm db:check-drift`.
- `GRANT` line: [not-checked] whether the baseline grants `breeze_app` on all future tables via `ALTER DEFAULT PRIVILEGES`; keep the explicit GRANT — it is idempotent.

### Registration lists (mechanical grep, all confirmed against contract)

| List | Entry | Why |
|---|---|---|
| `USER_ID_SCOPED_TABLES` (`rls-coverage.integration.test.ts:629`, next to `mobile_devices` :652) | **add** `'ticket_push_preferences'` | Shape 6 |
| `CORE_ORG_CASCADE_DELETE_ORDER` | none | no `org_id`; `ON DELETE CASCADE` on `users(id)` |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` / `CORE_DEVICE_ORG_DENORMALIZED_TABLES` | none | no `device_id` |
| `CORE_TENANT_EXPORT_POLICY` | none | no `org_id` ("A table with no org_id needs no entry"). Table has no json/jsonb/bytea by design. |
| `DUAL_AXIS_TENANT_TABLES` / `PARTNER_TENANT_TABLES` | none | |
| `AUDIT_ADMIN_REQUIRED_TABLES` | none | not append-only |

Export-policy classification per column, recorded for the reviewer even though no registry entry is required: `user_id` included, `assigned_enabled` included, `sla_scope` included, `created_at`/`updated_at` included; no open containers.

### Existing tables — no DDL

- `user_notifications.dedupe_key` is newly populated by the ticket branches. No column added, so `tenantExportPolicyRegistry.ts:366` is unchanged.
- `tickets`, `mobile_devices`, `users` untouched. No column added to any org-cascade table.
- `TicketEventEnvelope` gains `eventId?: string` on input / `eventId: string` on the consumed `TicketEvent` (queue payload only, no storage).

## API

`packages/shared/src/validators/ticketPushPreferences.ts`:
```ts
export const ticketSlaPushScopeSchema = z.enum(['off', 'owned', 'any']);
export const ticketPushPreferencesSchema = z.object({ assignedEnabled: z.boolean(), slaScope: ticketSlaPushScopeSchema });
export const updateTicketPushPreferencesSchema = ticketPushPreferencesSchema.partial().strict()
  .refine(v => v.assignedEnabled !== undefined || v.slaScope !== undefined, { message: 'No settings provided' });
export const TICKET_PUSH_PREFERENCE_DEFAULTS = { assignedEnabled: true, slaScope: 'owned' } as const;
export function resolveTicketPushPrefs(row: Partial<TicketPushPreferences> | null | undefined): TicketPushPreferences;
```

Routes (`apps/api/src/routes/users.ts`, `authMiddleware`, self-only, `user_id` always `auth.user.id`, never from the body):
- `GET /api/v1/users/me/ticket-push-preferences` → `{ settings: { assignedEnabled, slaScope } }`; missing row → defaults, no insert on read.
- `PATCH /api/v1/users/me/ticket-push-preferences` with `zValidator('json', updateTicketPushPreferencesSchema)` → `INSERT ... ON CONFLICT (user_id) DO UPDATE SET <provided fields>, updated_at = now()`; returns `{ settings }`; `writeRouteAudit` as `/devices/:id/settings` does [verified pattern `routes/mobile.ts:681`].
- No new mobile route; `/mobile/notifications/register|unregister` untouched [verified `routes/mobile.ts:325-328`].

Push payload contract (`data`):
```ts
{ type: 'ticket', ticketId: string, reason: 'assigned' | 'sla_breached', target?: 'response' | 'resolution', internalNumber?: string }
```
Title `Ticket assigned to you` / `SLA breached (response|resolution)`; body `<internalNumber ?? 'Ticket'> · <org name>`; `ttl` 86400 s assigned / 14400 s SLA (approval stays 60 s); `collapseId: ticket:<ticketId>:<reason>[:<target>]`; `threadId: ticket:<ticketId>`; `category: 'BREEZE_TICKET'`; `channelId: 'tickets'`; no `badge`; `apns-priority` unchanged at 10.

Sender generalisation (`services/expoPush.ts`): extract `PushSpec` and `dispatchPushToTokens(tokens, spec)`; `dispatchApprovalPushToTokens` becomes a wrapper over `buildApprovalPush` [verified current `:159-175`, `:216-284`]; add `buildTicketPush(args)`. `services/apns.ts`: `ApnsPayload` gains optional `threadId`/`category` [verified `:77-86`]; `buildApnsRequest` emits `aps['thread-id']`/`aps.category` only when set, so approval requests stay byte-identical.

## Backend flow

```
handleTicketEvent(event)
  eventId = event.eventId ?? job.id
  pushJobs: { tokens: TaggedPushToken[], spec: PushSpec }[] = []
  runWithSystemDbAccess:
    ticket.created (assigneeId) / ticket.assigned:
      skip if !assigneeId || assigneeId === actorUserId            (unchanged, :83)
      ticket = getTicket() or THROW → retry                        (unchanged)
      assignee = users{id,email,partner_id,status}; missing → terminal skip
      assignee.partner_id !== event.partnerId → terminal skip + warn + captureException   (D5)
      id = createNotification({ dedupeKey: ticket:<tid>:assigned:<uid>:<eventId> })
      if id === null → return []                                    (D2; also stops email replay)
      email as today
      prefs = resolveTicketPushPrefs(row)
      if prefs.assignedEnabled → maybeCollectPush(uid)
    ticket.sla_breached:
      ticket or THROW
      owner: if assigneeId && prefs.slaScope in ('owned','any') → candidate 'owned'
      any:   SELECT ... sla_scope='any' AND partner_id=$p AND status='active' LIMIT 500 → candidates 'any' (minus owner)
      per candidate: partner assert → getUserPermissions + hasPermission(TICKETS_READ) + canAccessOrg(event.orgId)
                     id = createNotification({ dedupeKey: ticket:<tid>:sla:<target>:<uid> }); null → continue
                     maybeCollectPush(uid)
      email: assignee only, as today
  maybeCollectPush(uid):
      if !isApnsConfigured() → return (once-logged)                (D8)
      throttle = checkNotificationThrottle('mobile-ticket', `user:${uid}`, 20, 300); !allowed → log, return   (D6)
      targets = getUserPushTargets(uid)  // getUserPushTokens + quietHours; filters status='active' AND notifications_enabled [verified :132-156]
      drop targets in quiet hours (D12); if none → return
      pushJobs.push({ tokens, spec: buildTicketPush(...) })
  AFTER context exits (#1105):
    send emails as today
    for job of pushJobs: await dispatchPushToTokens(job.tokens, job.spec)   // best-effort, 410 → purgeApnsToken as today
```

`services/ticketEvents.ts`: `emitTicketEvent` stamps `eventId: event.eventId ?? randomUUID()`. `ticketSlaWorker.ts` unchanged — it already emits `assigneeId` (nullable) and the envelope carries `partnerId` [verified `ticketEvents.ts:13-17`]; unassigned breaches now reach `'any'` subscribers.

## Mobile flow

Files under `apps/mobile/src/`:
- `services/notifications.ts`: add `parseTicketNotification(n): { ticketId, reason, target? } | null` (keys on `data.type === 'ticket' && typeof data.ticketId === 'string'`) beside `parseApprovalNotification`; Android channel `tickets` (inert). Make `setNotificationHandler` data-aware only for `shouldSetBadge: false` on ticket pushes — banner/sound behaviour unchanged in W07.
- `navigation/navigationRef.ts` (new): `createNavigationContainerRef<MainTabParamList>()`; `navigateToTicket(ticketId)` → `navigate('TicketsTab', { screen: 'TicketDetail', params: { ticketId } })` [verified route shape `MainNavigator.tsx:22-31, :58, :144`]; if `!isReady()` buffer one pending id and flush from `onReady`.
- `navigation/pushRouting.ts` (pure, node-testable): `resolvePushRoute(data)`, `shouldReplayResponse(identifier, lastHandled)`.
- `navigation/PushTapRouter.tsx` (new, sibling of `ApprovalGate` inside the authenticated + onboarded branch at `RootNavigator.tsx:303`): response listener → `navigateToTicket`; received listener (foreground) → `dispatch(fetchTickets())` only; on mount replay `getLastNotificationResponse()` [verified exported, unused, `notifications.ts`] once, identifier-guarded. Ignores non-ticket data.
- Precedence: if `approvals.focused` is set (the approval overlay is showing), the ticket navigation still happens underneath and is revealed when the decision clears — an explicit tap does not `clearFocus` a pending approval decision.
- `RootNavigator.tsx`: `ref={navigationRef}`, `onReady={flushPendingNavigation}`, mount `<PushTapRouter />`.
- `TicketDetailScreen` already loads by `route.params.ticketId` [verified W01]; no change required. Offline tap → its existing load-error state with Retry.
- Settings: three rows in the existing Notifications section of `screens/chat/components/SettingsSheet.tsx` [verified location; the row is currently a status readout, `:82-89`, `:413`]: "Assigned to me" switch; "SLA breaches" segmented Off / My tickets / All tickets. Shown only when `pushRegistration === 'ok'` [verified enum `store/authSlice.ts:19`]. Controls disabled offline (`useNetworkConnected`); optimistic update with rollback + toast; no offline write queue.
- `services/api.ts`: `getTicketPushPrefs()` / `updateTicketPushPrefs(patch)` via `coreRequest`. `store/notificationPrefsSlice.ts` (load/save thunks).

## Failure modes

| Failure | Behaviour |
|---|---|
| BullMQ retry after `getTicket` throw | no side effects before throw; retry proceeds (unchanged) |
| Retry after send failure | `createNotification` returns null → no second push/email; in-app row remains (at-most-once) |
| Crash between insert and send | push lost, in-app row survives; same posture as the SLA stamp [verified `ticketSlaWorker.ts:22`] |
| `ticket.created` + `ticket.assigned` both emitted for one create [verified separate emits `ticketService.ts:506, :694`] | two `eventId`s → two rows/pushes; `collapseId` shows one banner; product Q2 |
| Assignee in another partner (forged/moved user) | terminal skip, warn, Sentry; unit test forges it |
| Permission revoked between event and send | `canAccessOrg` false → no push; tap-time `GET /tickets/:id` is still authoritative (403 → error state) |
| APNs 410 unregistered | `purgeApnsToken` as today [verified `expoPush.ts:256-260`] |
| APNs not configured (self-host) | push phase skipped once-logged; in-app + email unaffected |
| Redis down | throttle fails open [verified]; dedupe is SQL |
| Throttle exceeded (bulk reassign) | push dropped and logged; in-app row + email written |
| `'any'` overflow > 500 | first 500 by user id + warning; owner always included |
| Quiet hours | push dropped, never deferred; in-app + email still created |
| Cold-start tap before container ready | buffered in `navigationRef`, flushed on `onReady` |
| Re-mount after re-login replays last response | identifier guard |
| Malformed `data` | parser returns null; router ignores |
| Android device | server skips FCM; app never registers |

### Salvaged from alternate designs

Two concrete facts from the risk-first attempt that the decisions above assume but never state:

- **Sizing the throttle and the 500-recipient cap.** The SLA sweep is the worst-case burst: `ticketSlaWorker` processes up to 200 rows per target [verified (alternate draft) `ticketSlaWorker.ts`], i.e. **≤ 400 breach events per sweep minute** across the two targets. D6's 20-per-5-min per-user window and D5's 500-recipient cap must be justified against that number in the plan (a single sweep with a partner-wide `'any'` opt-in is 400 events × N opted-in users before the throttle bites), and the fan-out integration test should seed a burst rather than a single event.
- **`mobile_devices.user_id` has no `ON DELETE CASCADE`** [verified (alternate draft) `apps/api/src/db/schema/mobile.ts:11`]. Pre-existing and out of W08 scope, but worth knowing while writing `ticket_push_preferences`: this design's `ON DELETE CASCADE` on `users(id)` is deliberately *stricter* than its nearest sibling, so a user-erasure test that passes for preferences says nothing about device rows. Do not "align" the new table down to the existing gap; file the device-row gap separately if the erasure runbook proves it bites.

## Testing

**Unit (Test API job):**
- `jobs/ticketNotifyWorker.test.ts`: dedupe null → no push and no email; self-assign skip; foreign-partner assignee → no insert, no push, `captureException`; `assignedEnabled=false` → in-app + email, no push; `slaScope` off/owned/any; unassigned breach reaches only `'any'` subscribers; `canAccessOrg=false` filtered; quiet hours drops token; throttle denied → no push, row still written; `isApnsConfigured=false` → no token reads; `eventId` fallback to `job.id`; tokens resolved inside and `dispatchPushToTokens` called after the system context (order spy, mirroring `ticketNotifyWorker.leak.test.ts`); assert compiled SQL of the partner filter (vacuous-Drizzle trap).
- `services/expoPush.test.ts`: `buildTicketPush` payload/ttl/collapse/thread/no-subject; approval wrapper output unchanged (snapshot).
- `services/apns.test.ts`: `thread-id`/`category` only when set; approval request byte-identical.
- `services/ticketEvents.test.ts`: `eventId` stamped, preserved when provided.
- `routes/users.test.ts`: GET defaults with no row, PATCH upsert/partial/`.strict()` 400, user id never from body, audit written.
- `packages/shared`: validator + `resolveTicketPushPrefs` totality.
- Mobile: `notifications.test.ts` (`parseTicketNotification` shapes/malformed), `pushRouting.test.ts`, `navigationRef.test.ts` (buffer-before-ready, flush once, replay guard), `notificationPrefsSlice.test.ts` (optimistic/rollback).
- `autoMigrate.test.ts` (ordering), `pnpm db:check-drift`, `scripts/check-migration-naming.sh`.

**Contract suites (Integration Tests job, real DB):**
- `rls-coverage.integration.test.ts` with the new allowlist entry.
- New `ticketPushPreferencesRls.integration.test.ts`: as `breeze_app` with user A context, select/insert/update on user B's row → 0 rows / 42501; system context sees all; cascade on user delete.
- New `ticketPushFanout.integration.test.ts`: cross-partner `'any'` opt-in receives nothing; org-scoped user receives only own-org breaches; cap honoured; dedupe replay yields one row. Confirm the file actually ran in the shard log.
- `tenantCascade.integration.test.ts`, `tenant-export-policy` + `tenantExportErasureRoundtrip` run to prove no registration is expected (no diff).

**Manual device checks (TestFlight, iOS):** assign from web → push → tap from terminated / background / foreground; reassignment A→B→A pushes twice; response and resolution breach via a short SLA policy; unassigned breach with "All tickets"; approval overlay focused then ticket tap; toggle each preference and verify server round-trip; revoked org access → 403 state; badge unchanged after ticket pushes; offline tap + Retry; self-hosted stack without APNs shows one info log and no worker errors.

## Open product questions

Each with the default the implementation assumes unless overridden.

1. **Lock-screen body includes the ticket subject?** Default: No — `<number> · <org>` only (D11).
2. **`ticket.created` with an assignee pushes like an assignment?** Default: Yes; only self-assign is skipped; `collapseId` dedupes the visual noise.
3. **Recipient set and cap for "All tickets" SLA breaches?** Default: opted-in active users in the ticket's partner holding `tickets:read` with access to the ticket's org, cap 500 per event, warning on overflow.
4. **Per-user burst cap?** Default: 20 pushes / 5 min per user via `checkNotificationThrottle`; in-app rows always written; tune from logs.
5. **Honour `mobile_devices.quiet_hours`, and does SLA bypass them?** Default: honour for both categories, drop never defer, no bypass.
6. **SLA breach on an unassigned ticket under the default `'owned'`?** Default: nobody is pushed; dispatchers opt into `'any'`.
7. **Self-assignment pushes?** Default: No (mirrors existing in-app skip).
8. **Badge count changes on ticket pushes?** Default: No.
9. **Email to `'any'` subscribers?** Default: No — preference governs push only.
10. **`push_notifications` audit rows?** Default: No for W07 (D7).
11. **Web Settings exposes the same toggles?** Default: later; same `/users/me/ticket-push-preferences` contract, trivial follow-up.
12. **Partner-level kill switch?** Default: No; revisit as a partner-wide notification policy if MSPs ask.

## Quorum note

**Judge status.** The Claude judge scored codex-design 8.5, mvp-first 7.5, risk-first 7 and named codex-design winner with seven grafts. The Codex judge (gpt-5.6-sol, xhigh) exceeded its time budget and produced no scores, so there was no second opinion at judge level. To close the gap, a narrow read-only Codex tie-break (gpt-5.6-sol, `high`, 2026-08-29, ~64k tokens) was run on the two hard-to-reverse disagreements; it opened `routes/users.ts:507`, `ticketNotifyWorker.ts:283`, `rls-coverage.integration.test.ts:626`, `tenantExportPolicyRegistry.ts:370`, `notifications.ts:157`, `ApprovalGate.tsx:51` and answered: (Q1) typed Shape-6 table `ticket_push_preferences` — "typed columns make partner-wide `sla_scope='any'` fan-out safe and indexable, unlike merged/unvalidated JSON, while the generic boolean model cannot cleanly represent the SLA enum"; (Q2) sibling `PushTapRouter` — "registrations return independently removable subscriptions, so a type-filtered ticket listener can coexist safely while avoiding regression-prone relocation of ApprovalGate's hydration, focus, and fetch behavior".

**Tie-break analysis, weighed against the repo:**
- *Preference storage* — Claude judge, Codex tie-break and this synthesis agree: typed table (D3). The jsonb route is contract-clean today but converts a schema concern into a per-event JSON-path query; the repo's own history says that gets retrofitted. The generic row model was rejected because the SLA preference is an enum, and because a CHECK bump per category is a migration per category anyway, so it buys nothing over `ADD COLUMN`.
- *Migration date* — risk-first's `2026-08-29-` filename is a verified contract break [verified `ls`]; D4 fixes it and adds a re-check step because the date is a moving target.
- *Listener ownership* — the Claude judge grafted the sibling router from mvp-first over codex-design's refactor, and the Codex tie-break independently agreed (D9). Adopted.
- *Recipient authorisation* — codex-design's per-recipient `getUserPermissions` + `canAccessOrg` is retained and risk-first's cheaper partner assertion is layered in front of it (D5). This is the only tenant boundary for pushes under a system context, so both checks stay.
- *Throttle scope* — mvp-first's every-recipient throttle wins over codex-design's `'any'`-only throttle (D6): bulk reassignment is the realistic spam case and the assignee is exactly who it hits.
- *eventId as BullMQ jobId* — rejected from codex-design; it changes queue dedupe semantics for every ticket event type. Payload-only `eventId` with `job.id` fallback (D2).
- *Audit rows, quiet hours, API location* — D7 (no rows, per codex-design/mvp-first), D12 (honour, per codex-design/risk-first), D10 (core user route, per risk-first). Each is reversible and was decided on repo precedent rather than split.

Net: codex-design's architecture with the Claude judge's grafts, all of which survived a check against the code and the Codex tie-break. No decision was split silently.
