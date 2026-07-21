# M365 Exchange Mailbox — Email-to-Ticket (Inbound + Outbound)

**Date:** 2026-06-29
**Status:** Design approved, pending implementation plan
**Author:** Todd Hebebrand (brainstormed with Claude)

## Summary

Let an MSP connect their own Microsoft 365 shared support mailbox (e.g. `support@msp.com`) directly to Breeze ticketing via Microsoft Graph, so inbound customer email becomes tickets and outbound replies are sent from that real mailbox — with **no MX changes and no forwarding rules**. Breeze reads and sends through the mailbox using an app-only (client-credentials) Graph connection that the MSP's Global Admin consents to once.

This is the API-based realization of the "Model B custom-domain" inbound path that Phase 4 deferred. It bolts a new feeder (delta-poll worker) and a new sender (Graph reply) onto the **existing** email-to-ticket pipeline; the core `processInboundEmail` / ticketing / SLA logic is unchanged.

Microsoft Teams is explicitly **out of scope** here and will be specced separately as a follow-on.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Auth model | App-only client-credentials, single multi-tenant Breeze Azure app, per-MSP admin consent | Survives staff turnover; true service-account; no per-user token. Microsoft retired Basic Auth + EWS, so OAuth/Graph is the only path. |
| App registration | **Separate** "Breeze Ticketing" app (own `TICKET_MAILBOX_M365_CLIENT_ID/SECRET`), distinct from the existing C2C backup app | Least privilege (only `Mail.ReadWrite` + `Mail.Send`); clean per-feature Application Access Policy scoping; admin consents to mail permissions separately from backup. |
| Tenancy axis | Per-partner (MSP's own support mailbox) | Matches existing partner-axis email-to-ticket model (`partner_inbound_domains`, partner-scoped ingest). |
| Inbound delivery | Scheduled **delta-query polling** (no webhooks) | No public webhook validation, no subscription renewal, naturally resilient to downtime. ~60–90s latency acceptable. |
| Mailbox hygiene | **Mark ingested messages read** (`Mail.ReadWrite`) | Human-visible mailbox reflects handled state; non-destructive. Delta cursor + dedup index are the real idempotency guarantee. |
| Outbound routing | Customer-facing replies via Graph `createReply` from the support mailbox; internal/tech notifications stay on the existing platform `EmailService` | Replies come from the MSP's real address and thread natively in the customer's mailbox; techs aren't routed through the customer mailbox. |
| Mailboxes per partner | N (multiple rows allowed) from day one | support@, helpdesk@, billing@ are common; low cost to allow. |

## Reuse map (what already exists)

| Existing asset | File | How reused |
|---|---|---|
| App-only token + admin-consent primitives | `apps/api/src/services/c2cM365.ts` | `acquireClientCredentialsToken`, `buildAdminConsentUrl`, `testGraphAccess`, `isM365TenantId` / `M365TenantId` brand, 5-min-buffer freshness — pointed at the new app's env creds. |
| Signed-state + CSRF-cookie OAuth callback pattern | `apps/api/src/routes/accounting/index.ts` | Connect/callback hardening; callback is **unauthenticated at middleware**, authenticated via signed state + browser-binding cookie, written under system context (the QuickBooks callback gotcha). |
| Inbound pipeline core | `apps/api/src/services/inboundEmail/inboundEmailService.ts` (`processInboundEmail`, `findTicketInPartner`, `createFromEmail`, `appendInboundComment`) | Consumed unchanged via the `NormalizedInboundEmail` shape. |
| Dedup + audit/dead-letter | `ticket_email_inbound` `(partner_id, provider_message_id)` unique index, `provider` column | New `provider='m365'`, `provider_message_id` = Graph immutable message id. |
| Inbound queue + worker shape | `inbound-email` BullMQ queue, `jobs/inboundEmailWorker.ts` | New poll worker enqueues into the same queue. |
| Outbound threading + subject token | `apps/api/src/services/inboundEmail/outboundThreading.ts` | Subject token `[T-YYYY-NNNN]` kept for human visibility + fallback matching. |
| Notification fan-out | `apps/api/src/jobs/ticketNotifyWorker.ts` | Customer-facing branches gain a "partner has M365 conn?" routing fork. |
| Secret-at-rest registry | `apps/api/src/services/encryptedColumnRegistry.ts` | Available if a BYO-creds column is ever added (not in Phase 1). |

> **Not reused:** `m365_connections` (`db/schema/m365.ts`) is **org-axis** and stores a per-org BYO client secret for a different feature. Wrong axis, wrong model — left untouched.

## Architecture

```
                 ┌─ scheduled poll worker (per connected mailbox) ─┐
Graph mailbox ──▶│  /messages/delta  →  normalize  →  mark read    │──▶ inbound-email queue
 (Inbox)         └──────────────────────────────────────────────────┘        │
                                                                              ▼
                                                          processInboundEmail()  (UNCHANGED)
                                                          threading · dedup · org-route · create/append
                                                                              │
ticket.commented (public) ─▶ ticketNotifyWorker ─┬─ partner has M365 conn? ─▶ Graph createReply (FROM support@)
                                                  └─ else ──────────────────▶ existing EmailService (platform)
ticket.assigned / tech notes ────────────────────────────────────────────▶ existing EmailService (always)
```

### New units (each independently testable)

| Unit | File (proposed) | Responsibility |
|---|---|---|
| Mailbox connection service | `services/ticketMailbox/connectionService.ts` | CRUD + consent state for `ticket_mailbox_connections`; verify via `testGraphAccess` + mailbox read probe |
| Connect/callback routes | `routes/tickets/mailboxConnect.ts` | admin-consent initiation + callback (signed state + CSRF cookie) |
| Graph mail client | `services/ticketMailbox/graphMailClient.ts` | thin Graph wrapper: delta list, get message + headers, mark-read, createReply, sendMail; token via reused `c2cM365` primitives; 429 `Retry-After` backoff |
| Delta poll worker | `jobs/ticketMailboxPollWorker.ts` | per-mailbox delta sweep on schedule; normalize → enqueue; persist `delta_link`; mark read |
| Graph normalizer | `services/ticketMailbox/normalizeGraphMessage.ts` | Graph message → existing `NormalizedInboundEmail` |
| Graph outbound sender | `services/ticketMailbox/graphReplySender.ts` | invoked by ticketNotifyWorker for customer-facing email on M365-connected partners |

## Data model & tenancy

### New table `ticket_mailbox_connections` — partner-axis (Shape 3)

| Column | Notes |
|---|---|
| `id` uuid pk | |
| `partner_id` uuid not null | FK→partners; `breeze_has_partner_access(partner_id)` policy |
| `tenant_id` text not null | Entra GUID (validated by `M365_TENANT_ID_REGEX`); **not a secret** |
| `mailbox_address` text not null | shared support UPN, e.g. `support@msp.com` |
| `display_name` text | |
| `status` text/enum | `pending_consent` · `connected` · `error` · `reauth_required` · `disabled` |
| `delta_link` text | opaque Graph delta cursor; nullable until first sweep |
| `last_polled_at` timestamptz | observability |
| `last_message_at` timestamptz | observability |
| `last_error` text | last probe/poll failure |
| `strict_sender_auth` boolean default false | quarantine non-DMARC-pass senders when true |
| `created_by` uuid / `created_at` / `updated_at` | |

- Unique `(partner_id, mailbox_address)`. Multiple mailboxes per partner allowed.
- **No secret column.** Breeze's app secret lives in env; per-partner we store only the non-sensitive tenant GUID.
- App-only tokens are short-lived and **cached in-memory** keyed by `tenant_id` (re-acquired on 5-min buffer via `acquireClientCredentialsToken`). No token persisted; no refresh rotation (client-credentials has no refresh token). `delta_link` is the only durable cursor.

### RLS / tenancy contract (per CLAUDE.md)

- Migration creates table **and** policies together; idempotent (`IF NOT EXISTS` / `pg_policies` checks); `FOR ALL TO breeze_app` + system-scope-bypass form copied from the canonical partner-axis policy (`2026-06-09-a` style).
- Add to `PARTNER_TENANT_TABLES` **and** `ORG_AXIS_EXCLUDED` (no `org_id`) in `rls-coverage.integration.test.ts`, **same PR**.
- Background-path writes/reads run under `runOutsideDbContext(() => withSystemDbAccessContext(...))` — partner-axis reads need system context; bare-pool write = silent 0-row.
- `ticket_email_inbound.provider` gains `'m365'`; dedup rides the existing `(partner_id, provider_message_id)` unique index.

## Inbound flow (delta poll → ticket)

**Scheduling.** BullMQ repeatable job (`jobId: ticket-mailbox-poll-sweep`, colon-free) every ~60–90s; fans out one job per `status='connected'` mailbox. Per-mailbox advisory lock prevents overlapping double-processing.

**Per-mailbox sweep:**
1. Acquire app-only token (cached). `GET /users/{mailbox}/mailFolders/inbox/messages/delta` — no cursor on first run, else stored `delta_link`. `$select=id,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,conversationId,body,bodyPreview,hasAttachments,internetMessageHeaders`. Page through `@odata.nextLink`.
2. Each new message → `normalizeGraphMessage()` → `NormalizedInboundEmail`:
   - `provider='m365'`, `providerMessageId = message.id`, `resolvedPartnerId` set (we polled this partner's mailbox).
   - Threading keys from `internetMessageHeaders`: `Message-Id` → `internetMessageId`; `In-Reply-To` / `References` parsed from headers, feeding existing `findTicketInPartner`. `conversationId` retained as secondary match hint and for outbound `createReply`.
   - Sender auth (R4 anti-spoof gate): parse `Authentication-Results` for `dmarc=pass`. If absent/≠pass, fall back to "delivered to Inbox (not Junk) by Exchange" as the trust signal; `strict_sender_auth=true` quarantines non-DMARC-pass senders. Verdict recorded in `ticket_email_inbound`.
3. Enqueue to `inbound-email` → `processInboundEmail()` unchanged (match/create/append, autoresponse, loop-prevention, customer→org routing).
4. After successful enqueue, **mark read** (`PATCH …/messages/{id} {isRead:true}`). Mark-read failure logged, non-fatal.
5. Persist new `delta_link` **only after** the page is fully enqueued (at-least-once; crash mid-page replays; dedup index absorbs duplicates).

**Seam addition:** `NormalizedInboundEmail` gains an optional `resolvedPartnerId`; when present, `processInboundEmail` skips `resolvePartnerByRecipient`. Single optional field; Mailgun path untouched.

**Outbound targeting:** store the Graph message id on the ticket thread (via the `ticket_email_inbound` row / `emailMessageId`) so outbound `createReply` can target the original message.

## Outbound flow (Graph reply from support@)

In `ticketNotifyWorker`, customer-facing branches (`ticket.commented` public, resolved `status_changed`, autoresponse) check: does this ticket's partner have a `connected` M365 mailbox the ticket arrived through?
- **Yes** → `graphReplySender`:
  - Existing email thread → `POST /users/{mailbox}/messages/{originalGraphMessageId}/createReply`, PATCH body with comment content, then `POST …/send`. Graph maintains `conversationId` + `References` natively; lands in the customer's existing thread, `From: support@msp.com`. (Graph rejects setting `In-Reply-To`/`References` via `internetMessageHeaders` — only `x-`-prefixed custom headers — so `createReply` is the correct threading primitive, not `sendMail`.)
  - No original message id (in-app ticket, first outbound) → `POST /users/{mailbox}/sendMail` with subject token `[T-YYYY-NNNN]` for fallback matching.
- **No** → existing `EmailService` (platform `{slug}@tickets.<domain>`), exactly as today.

**Tech/assignee notifications always stay on `EmailService`.**

**Loop safety:** sent replies go to Sent Items; we poll Inbox only → no self-ingest. Existing two-layer loop-prevention + one-time autoresponder still apply.

## Setup / consent UX

"Connect Microsoft 365 mailbox" card in partner ticketing settings (admin + MFA-gated, mirroring the accounting card):
1. Admin enters support mailbox address → **Connect** → `GET …/mailbox/connect` builds admin-consent URL (`buildAdminConsentUrl`, signed-state JWT + CSRF cookie), redirects browser. Row created `status='pending_consent'`.
2. Callback (`GET …/mailbox/callback`, **unauthenticated at middleware** — Microsoft redirects the browser with no Bearer; authenticated via signed state + cookie; written under system context) captures `?tenant=` GUID, persists it.
3. Breeze probes: acquire token + `GET /users/{mailbox}/messages?$top=1`. Success → `connected`; failure (commonly Application Access Policy not yet scoped) → `error` with remediation hint.
4. **Documented admin step:** MSP admin runs `New-ApplicationAccessPolicy` (Exchange Online PowerShell) to scope Breeze's app to *only* the support mailbox (least privilege — `Mail.ReadWrite`/`Mail.Send` are tenant-wide otherwise). Card shows the exact snippet with their mailbox + Breeze's app id. **Re-test** button re-runs the probe.

Disconnect → `status='disabled'`, stops polling, drops cached token (admin separately revokes consent in Entra — show the link).

## Error handling & edge cases

- **Token failure / consent revoked** → 401 → `status='reauth_required'`, polling paused, partner notified in-app (mirrors accounting reauth).
- **`delta_link` expired (410 Gone)** → resync: restart delta from now (`$deltatoken=latest`), warn. No history backfill (avoids ancient mail flooding into tickets).
- **Failure-row durability** → audit/quarantine writes use a **fresh** `runOutsideDbContext(() => withSystemDbAccessContext(insert))`, never the poisoned worker txn; `getConfig()` reads on the worker path are defensive.
- **Attachments** → Phase 1 parity with the Mailgun path only; Graph attachment fetch flagged as a follow-up if needed.
- **Graph throttling (429)** → honor `Retry-After`, exponential backoff in `graphMailClient`; per-mailbox sweeps independent so one throttled tenant doesn't stall others.
- **Mailbox deleted / address changed** → probe 404 → `status='error'`, polling paused, surfaced on the card.

## Testing

- **Unit:** `normalizeGraphMessage` (header parsing, threading keys, DMARC verdict, missing-header fallbacks); `graphReplySender` createReply-vs-sendMail decision; token-cache freshness. Graph HTTP mocked.
- **Worker:** delta paging + cursor persistence + at-least-once replay hitting the dedup index; mark-read failure non-fatal; advisory-lock no-double-process. System-actor reopen via direct partner-scoped UPDATE (Phase 4 gotcha #3), real driver.
- **RLS (real-DB integration):** `ticket_mailbox_connections` forge — cross-partner insert/select fail as `breeze_app` (non-vacuous; `.env.test` symlinked so `breeze_app` is `rolbypassrls=f`). Allowlist entry; `rls-coverage` green.
- **Route:** connect builds signed state + CSRF cookie; callback rejects bad state/cookie; callback has **no** `authMiddleware`; MFA gate on connect/disconnect.
- **Integration (5433 test DB):** normalized-message → `processInboundEmail` → ticket created/threaded, reusing existing harness.
- **`no-silent-mutations`** count bumped for any new web mutation handler.

## Scope / phasing

**In scope (Phase 1):** per-partner connect/consent, delta-poll inbound with mark-read, Graph outbound customer replies, settings card + PowerShell guidance, full RLS/tests.

**Explicitly deferred:** Microsoft Teams (own spec); BYO-app-registration variant; webhook (push) inbound as a latency optimization; attachment handling beyond Mailgun parity; per-org mailbox connections.

## Open follow-ups (post-Phase-1)

- Teams integration spec (notifications first, then chat→ticket).
- Optional webhook inbound for sub-minute latency, with delta-query backstop.
- Attachment ingestion via Graph `$value`.
- Per-org mailbox connections (org-axis variant) if customers want to connect their own mailboxes.
