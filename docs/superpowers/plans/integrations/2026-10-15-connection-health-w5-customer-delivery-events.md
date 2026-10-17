---
tracking_issue: LanternOps/breeze#8844
wave: W05 (#8849)
---

# Connection Health W5: Customer-Admin Delivery Setting and Health Events

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Every behaviour change is written red first.

**Goal:**
- An MSP can choose, partner-wide and per org, whether customer org admins hear about their own org's broken connections. They hear through in-app notices and the daily digest. The default stays off.
- Automations and webhooks can react to `integration.health_opened` / `integration.health_resolved`, with a payload that carries no provider text.
- An incident about a webhook is never delivered to that webhook.

**Spec:** `docs/superpowers/specs/integrations/2026-10-15-connection-health-notifications-design.md`, sections §2.4 (events), §4 (recipients), §6 (settings), §9 (W5 row) and §12.1. Earlier waves' plans are in this directory: W1, W2 and W3 have merged. W4 (#8848) is in flight and this wave does not depend on it. Its files (new sources, nudges, the `/admin/system` heartbeat) are left alone.

## Settings rule 9 accounting

| Concept | Home | Level | Resolver | Places before → after |
|---|---|---|---|---|
| Customer org admins receive connection health notices | `/integrations` → **Health notifications** card, under the Connection Health panel | partner default → org override. Blank means inherit, and the inherited value and its source are shown. | `resolveCustomerAdminsNotified(orgId)` (`services/connectionHealth/customerDelivery.ts`) | 0 → 1 (one card; partner and org level are edited in it) |

**Storage:** `partners.settings.connectionHealth.customerAdminsNotified` (boolean; absent means off) and `organizations.settings.connectionHealth.customerAdminsNotified` (boolean; absent means inherit). These are spec §6 verbatim, and no new table is added (spec [R]).

## Decisions made by this plan

| # | Decision | Why |
|---|---|---|
| D1 | **The setting has dedicated routes:** `GET /connection-health/settings?orgId=`, `PUT /connection-health/settings/partner` and `PUT /connection-health/settings/orgs/:orgId`. Each write is one atomic `jsonb_set` of `settings.connectionHealth.customerAdminsNotified`, or removes that key for inherit. | The generic writers do not work for this setting. `PATCH /orgs/partners/me` strips unknown keys (strict schema, default strip). `PATCH /orgs/organizations/:id` replaces the whole blob, so a card on `/integrations` would have to round-trip the org's entire settings. A path-level update touches nothing else, and secret paths stay as they are. |
| D2 | **Partner write gates:** `requireScope('partner')`, `organizations:write`, MFA, and `canManagePartnerWidePolicies`. **Org write gates:** `requireScope('partner','system')`, `organizations:write`, MFA, and `canAccessOrg(orgId)`. Org-scope callers cannot write either level. | This mirrors the existing partner and org settings writes (`orgs.ts` `/partners/me` and `/organizations/:id`). The setting decides what the MSP sends to its customers, so a customer admin must not be able to turn it on for themselves. The GET returns `canManagePartner` and `canManageOrg`, so the card is read-only exactly when a save would 403 (the `partnerAiDataPolicy` pattern). |
| D3 | **The resolver is org first, then partner, then off.** Only a stored boolean counts. Anything else is ignored and falls through to the next level, with a warn log. | The value can still arrive through the system-scope wholesale settings PATCH, which skips the schema (the `aiApprovalTimeout` precedent). |
| D4 | **With the setting on, recipients of org incidents are `resolveUsersWithPermissionForOrg(orgId, repair)`.** That is org members whose org role grants the permission, plus partner users covering the org. In the digest those users must also hold `view`. With the setting off, nothing changes (W1–W3 behaviour). Partner-wide incidents (`org_id IS NULL`) never reach customer users. | Spec §4. |
| D5 | **The setting is resolved at delivery time, with no snapshot.** In-app notices read it when the outbox drains, and the digest reads it on every send (§4 recheck). Turning it off stops future notices and digests. It does not retract in-app notices already delivered. | Notices are history, and §4 recomputes digest recipients at send time. |
| D6 | **A digest to a customer user (`users.org_id IS NOT NULL`) uses the new purpose `customer.connection_health_digest`.** That purpose is on the partner lane, `general` stream, with `fallbackFrom: partner_display_name`, and sends with `partnerId = users.partner_id`. Partner staff keep `staff.connection_health_digest`. `partnerName` is passed for the fallback From. The customer copy drops "in Breeze" and keeps the reason neutral ("you can fix these connections"), because an org-scope grant owner gets it too, whatever the setting says. | The mail-purpose registry rule says customer-facing mail goes on a partner stream (`mailPurposes.ts` header). A customer must not get a Breeze-branded staff mail about their own MSP's tooling. This also covers an org-scope grant owner. |
| D7 | **The event outbox is a new nullable column, `connection_health_incidents.event_state`** (`'opened'`/`'resolved'`). It records what event consumers were last told. An event is due when the row's state differs from it: open means `opened`, resolved means `resolved`, and a pending row (`opened_at IS NULL`) has no state. A publisher step runs after the notices in each reconcile run. Each due row gets its own system transaction, which takes `SELECT … FOR UPDATE SKIP LOCKED`, publishes, and records the state it published. `publishEvent` itself escapes the DB context, so the row lock is held for one Redis round trip. Two overlapping drains therefore never publish one row out of order, and the record always matches what was sent. | `publishEvent` must run after commit (`eventBus.ts`). `pending_notice` cannot double as the event outbox: it is cleared without a `resolved` notice when nobody was notified, and it stays quiet on seeds and same-episode reopens. Consumers need the opened/resolved pair even when no human was notified. |
| D8 | **There is no event burst.** The migration baselines (only in the same DO block that adds the column, so a re-run can never acknowledge an event that became due later) every existing opened row's `event_state` to its current state. A first-run seed, which sends no notice, also sets `event_state = 'opened'` without publishing. A seeded incident therefore emits only its `resolved` event later. | This is the same no-burst rule as §1.2 seeding. A late `resolved` for an incident the consumer never saw open is harmless: the payload is self-describing. |
| D9 | **Event ids are deterministic UUIDs.** Delivery is at least once *to the event bus*. End-to-end delivery is whatever the bus and webhook pipeline already guarantee: local subscriber failures are logged and swallowed. The ids are a hash of `(incidentId, type, openedAt, flapCount)` for opened and `(incidentId, type, resolvedAt)` for resolved. Delivery is at least once. A crash between publish and mark re-publishes the same id, and webhook delivery dedupes on `(webhook_id, event_id)`. | This follows the `migrationWindows` precedent. A same-episode reopen increments `flap_count`, so its new `opened` event gets a new id. |
| D10 | **Partner-wide incidents (`org_id IS NULL`) emit no events.** The outbox scan is `org_id IS NOT NULL`, and the migration backfill leaves those rows at NULL. | `publishEvent` requires an org, and webhooks are org-owned. Fanning a partner-owned connection out to every org's webhooks would show partner tooling state on customer-owned endpoints. A partner-level event channel is deferred. |
| D11 | **Events are not gated by `customerAdminsNotified`.** | A webhook or automation only receives these events if someone subscribed to them for that org, and the payload carries no provider text (§2.4). The setting governs notices to people. |
| D12 | **The payload is `{ incidentId, orgId, sourceKind, sourceId, condition, severity, fixHref, openedAt, resolvedAt, resolution }`.** It carries codes and ids only. It never carries `detail`, `displayName` (user- or provider-entered text, which may hold an email or a URL), the owner, notified users or `ownerFixHref`. That also keeps the payload safe for org event-WebSocket subscribers, who do not have the incident's view permission. For `oauth_grant`, `sourceId` is `null`. | Spec §2.4. An OAuth `source_id` embeds the grant owner's user id (`<account>:<client>`), and the owner is personal data. |
| D13 | **Self-delivery exclusion lives in `handleWebhookFanoutEvent`.** An `integration.health_*` event whose payload `sourceKind === 'webhook'` skips the webhook whose `id === sourceId`, before any delivery row is created. | This is the one fan-out point for both local and queue dispatch. Excluding before the insert means the recovery sweep can never revive the delivery. Manual test and retry stay explicit operator actions. The webhook source arrives in W4. The filter is keyed on the literal kind, so it is live the moment W4 ships. |
| D14 | **Migration `2026-12-30-120000-connection-health-event-outbox.sql`**, not the dispatch's `2026-12-29-260000` slot. | `260000` is not a valid time, and main already has `2026-12-30-110500`, so the slot would not sort last. |

## Advisor quorum (Codex, xhigh, read-only), after the first draft

- **Agreed:** D1, D6, D10 and D13.
- **Adopted:**
  - D1: atomic init of a missing or malformed `connectionHealth` block.
  - D6: neutral customer copy.
  - D7: a per-row lock across publish → mark.
  - D8: an initialization-only backfill.
  - D9: the delivery guarantee is stated precisely.
  - D12: `displayName` is dropped.
- **Not adopted:** the immutable per-transition outbox table that Codex prefers. Events are **level-triggered by design**, so consumers converge on each incident's current state. A flap between two drains is coalesced (goal 3, no spam), and an event never contradicts the current state. A transition table would be a new org-cascade tenant table, with RLS and every registration, to deliver intermediate flaps that the spec explicitly suppresses for humans. Retention deleting a 90-day-old unpublished resolve needs the publisher to have failed for 90 days, which is accepted.

## Files

**API**
- `services/connectionHealth/customerDelivery.ts` (new): the pure `resolveCustomerAdminsNotifiedFrom(partnerSettings, orgSettings)`, the system-scope loader `resolveCustomerAdminsNotified(orgId)`, and the batch loader `loadCustomerAdminsNotified(orgIds)` for the digest.
- `services/connectionHealth/recipients.ts`: org incidents widen to org members when the setting is on.
- `services/connectionHealth/digest.ts` and `digestStore.ts`: audience widening, the customer purpose and copy, and `loadActiveUsers` gains `orgId`.
- `services/connectionHealth/digestEmail.ts`: `audience: 'staff' | 'customer'` footer copy.
- `services/emailDomains/mailPurposes.ts` (+ tests): `customer.connection_health_digest`.
- `services/connectionHealth/events.ts` (new): the payload builder, event ids, and `publishPendingEvents(now)`.
- `services/connectionHealth/store.ts`: seeds set `event_state = 'opened'`.
- `services/connectionHealth/reconcile.ts`: calls the publisher after notices and adds `events` to the run result.
- `services/eventBus.ts`: the union and `EVENT_TYPES`.
- `workers/webhookDelivery.ts`: the self-delivery filter.
- `db/schema/connectionHealth.ts`, the migration, and the export-policy classification for `event_state`.
- `routes/connectionHealthSettings.ts` (new), mounted at `/connection-health/settings`, plus whatever route-gate contract tests require.

**Web**
- `components/integrations/ConnectionHealthSettingsCard.tsx` (new): mounted in `IntegrationsPage.tsx` under `ConnectionHealthPanel` and hidden for org scope. Saves autosave with a toast through `runAction` (rule 7).
- `webhooks/WebhookForm.tsx`: the event options for the two new types.
- New `en` keys plus the 7 other locales, with real translations.

**Docs:** `apps/docs/.../features/notifications.mdx` (the setting) and `webhooks.mdx` (events and payload).

## Tasks

- [ ] T1 Resolver (pure + loader), red-first unit tests: org wins, partner fallback, default off, invalid values ignored.
- [ ] T2 Recipients: notifier and digest honour the setting. Red tests: off means partner-only (unchanged); on means org members are included; partner-wide incidents are never widened; the digest view recheck still applies to customer users.
- [ ] T3 Customer mail purpose and copy. Red tests: the registry and its tests; a digest to an org user uses the partner lane with `partnerId`.
- [ ] T4 Migration, schema and export classification. Store seeds set the baseline. Red tests: store seed sets `event_state`.
- [ ] T5 Event types plus publisher. Red tests: due-row selection, payload has no `detail` and nulls the OAuth `sourceId`, deterministic ids, mark after publish, a publish failure leaves the row due, partner-wide rows are skipped.
- [ ] T6 Webhook self-delivery exclusion. Red test: the webhook incident skips its own webhook and still delivers to others.
- [ ] T7 Settings routes. Red route tests: gates (scope, permission, MFA, partner-wide, org access), the atomic write, `null` means inherit, and the GET shape with `canManage*`.
- [ ] T8 Web card, locales, and webhook picker. Component tests use `runAction`.
- [ ] T9 Docs.
- [ ] T10 Gates:
  - targeted API and web vitest;
  - `tsc --noEmit` for api and web;
  - `pnpm db:check-drift`;
  - the `connectionHealth*`, export-policy and tenant-cascade integration suites on a per-worktree test stack;
  - one `/pr-review-toolkit:review-pr` round.

## Deferred

- A partner-level event channel for partner-wide incidents (D10).
- Retracting in-app notices already delivered when the setting is turned off (D5).
- Translated digest copy. All digest mail is English today, as in W3.
