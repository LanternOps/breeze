# Ticketing Phase 4 — Email-to-Ticket Design

**Status:** Approved design (2026-06-13). Next: implementation plan via writing-plans.

**Goal:** Close the original native-ticketing roadmap (`docs/superpowers/specs/2026-06-09-native-ticketing-design.md` §8, phase 4). Inbound email creates/updates tickets; technician replies email the requester with proper threading; new email-tickets get a one-time autoresponse. Provider-abstracted, Mailgun Routes as the first concrete impl.

**Prerequisite state (already shipped):** Phase 1 landed the ticket-side hooks this design builds on — `ticket_source` enum already includes `'email'`; `tickets.email_message_id` / `tickets.email_thread_key` columns exist; `tickets.submitter_email` / `submitter_name` exist; `ticket_comments.author_name` / `author_type` exist (for attributing non-portal senders). `partners.slug` is unique (drives the inbound address); `partners.settings` JSONB holds config. The outbound `services/email.ts` already abstracts Resend/SMTP/Mailgun. The `ticketNotifyWorker` already emails `submitterEmail` on public comments. **Net-new in this phase:** the `ticket_email_inbound` table, the inbound provider abstraction + webhook route + worker, outbound threading headers, the autoresponder, and the Settings → Inbound Email UI.

**Decisions locked during brainstorming (2026-06-13):**
- **D1 — Scope:** full loop + autoresponder (inbound pipeline + threaded outbound replies + one-time acknowledgement on email-created tickets).
- **D2 — Provider:** build a provider-agnostic inbound abstraction, ship **one** concrete impl (Mailgun Routes). Second provider (Resend Inbound) is interface-only this phase.
- **D3 — Unknown senders:** quarantine for review — do NOT auto-create a ticket from a sender that doesn't match a known portal user. Surface in a dead-letter/review queue with a Convert-to-ticket action.
- **D4 — Addressing:** per-partner subdomain token — hosted `{partner-slug}@tickets.<domain>`; self-hosted a per-partner configured address. Partner resolved strictly from the recipient (To/envelope); sender untrusted.

---

## 1. Architecture & Data Flow

Provider webhook → thin HTTP route → enqueue → worker does the real work. The handler stays dumb so a provider retry never double-processes and a slow parse never holds the request open.

```
Mailgun Route  ──POST──▶  POST /webhooks/tickets/email-inbound
                          (verify HMAC, return 202 fast, enqueue raw envelope)
                                   │
                          BullMQ queue: ticket-email-inbound
                                   │
                          inboundEmailWorker
                          ├─ log raw envelope → ticket_email_inbound (audit + DLQ)
                          ├─ idempotency: skip if (partner_id, provider_message_id) seen
                          ├─ resolve partner from recipient (To / envelope-to)
                          ├─ thread-match: In-Reply-To/References → email_thread_key,
                          │                fallback subject token [T-YYYY-NNNN]
                          ├─ matched   → addTicketComment (public) + reopen rules
                          ├─ unmatched + known sender   → createTicket(source:'email')
                          ├─ unmatched + unknown sender → quarantine (no ticket)
                          └─ on created/replied → outbound threading + autoresponder
```

Outbound replies reuse the **existing** `ticketNotifyWorker` public-comment email path; this phase adds threading headers to it rather than introducing a second outbound worker.

**Units & boundaries:**
- `routes/tickets/emailWebhook.ts` — HTTP edge: verify signature, enqueue, respond. No business logic.
- `services/inboundEmail/` — provider abstraction (`InboundEmailProvider` interface + `MailgunInboundProvider`) and the `NormalizedInboundEmail` shape.
- `jobs/inboundEmailWorker.ts` — orchestration: log, resolve, match, dispatch to `ticketService`.
- `services/ticketService.ts` — unchanged create/comment surface; the worker is just another consumer (no handler-only logic, per §8a of the parent design).
- Outbound threading helper in the email composer + `ticketNotifyWorker`.

## 2. Data Model

**New table `ticket_email_inbound` — Shape 3 (partner-axis).** RLS enabled + forced in the creating migration; partner-access policy; allowlisted in `rls-coverage.integration.test.ts` (`PARTNER_TENANT_TABLES`).

| Column | Notes |
|---|---|
| `id` uuid pk | |
| `partner_id` uuid not null → partners(id) | RLS axis |
| `provider` varchar | e.g. `'mailgun'` |
| `provider_message_id` text | **unique per partner** (idempotency vs provider retries) |
| `from_address` text | untrusted; attribution only |
| `to_address` text | recipient used for partner resolution |
| `subject` text | |
| `message_id` text | sender's RFC Message-ID |
| `in_reply_to` text, `references` text | threading inputs |
| `parse_status` varchar | `'matched' \| 'created' \| 'quarantined' \| 'failed' \| 'ignored'` |
| `ticket_id` uuid nullable → tickets(id) on delete set null | populated on matched/created |
| `error` text | failure detail for the DLQ view |
| `raw` jsonb | full provider envelope (audit + reprocess) |
| `created_at` timestamp default now() | |

Indexes: unique `(partner_id, provider_message_id)`; `(partner_id, parse_status, created_at)` for the review queue.

**Config (no migration)** in `partners.settings.ticketing.inbound`:
```jsonc
{
  "enabled": false,
  "address": "<partner-slug>@tickets.<domain>",   // derived default; overridable for self-hosted
  "defaultTriageOrgId": "<uuid|null>",             // currently informational; see §4 note
  "autoresponderEnabled": true
}
```

New config/env: `TICKETS_INBOUND_DOMAIN` (e.g. `tickets.example.com`), `MAILGUN_INBOUND_SIGNING_KEY` (HMAC verification key for inbound routes — distinct from the outbound `MAILGUN_API_KEY`).

## 3. Inbound Provider Abstraction

`services/inboundEmail/types.ts` defines:

```ts
interface NormalizedInboundEmail {
  provider: string;
  providerMessageId: string;
  to: string;            // recipient (partner resolution)
  from: string;          // sender (untrusted)
  fromName?: string;
  subject: string;
  text: string;          // plain body (rendered)
  html?: string;         // raw HTML retained, not rendered in v1
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  autoSubmitted?: string;  // Auto-Submitted header value, for loop prevention
  precedence?: string;     // Precedence header, for loop prevention
  attachments: { filename: string; contentType: string; size: number }[]; // metadata only (v1)
  raw: unknown;
}

interface InboundEmailProvider {
  readonly name: string;
  verify(req: HonoRequest): Promise<boolean>;   // HMAC / signature check
  parse(req: HonoRequest): Promise<NormalizedInboundEmail>;
}
```

`MailgunInboundProvider` implements both: signature verification via `createHmac('sha256', signingKey)` over Mailgun's `timestamp + token` (the existing pattern in `workers/webhookDelivery.ts`), and `parse` mapping Mailgun's multipart form fields to `NormalizedInboundEmail`. A future `ResendInboundProvider` only implements this interface — the worker is provider-agnostic.

## 4. Matching, Reopen & Attribution

- **Partner resolution:** recipient address (`to` / envelope-to) → match against `partners.settings.ticketing.inbound.address` (or derived `{slug}@TICKETS_INBOUND_DOMAIN`). No match → `parse_status='ignored'`. Sender is never used to infer partner/org.
- **Thread key:** prefer `In-Reply-To` / `References` matched against `tickets.email_thread_key`; fallback to a `[T-YYYY-NNNN]` token in the subject. No match → unmatched path.
- **Reopen rules (carried from parent §4):** matched reply to a `resolved` ticket reopens it to `open`; a `closed` ticket is immutable — create a new ticket **linked** to the old one instead.
- **Org resolution for new tickets (known sender):** sender email → `portal_users` lookup → that user's org. (The `defaultTriageOrgId` setting exists for a future "accept unknown into triage" mode but is NOT used to auto-create in v1 — unknown senders quarantine per D3.)
- **Attribution:** sender matched to a portal user → comment/ticket attributed to that user. Accepted-but-unknown senders (only reachable on the *matched-reply* path, where the partner+ticket are already trusted) → `author_name` = display name, `author_type = 'email'`.
- **Internal-note safety:** email-sourced comments are ALWAYS `is_public = true`. Email can never create an internal note.

## 5. Outbound: Threading, Autoresponder, Loop Prevention

- **Threading headers:** when the notify worker emails the requester on a public comment, set `Message-ID` (generated + stored on the comment/ticket), `In-Reply-To`, and `References` so the reply threads in the requester's client. Subject carries `[T-YYYY-NNNN]`. `Reply-To` = the partner's inbound address.
- **Autoresponder:** on `createTicket(source:'email')` for an accepted sender, send a single "we received your request — it's `T-YYYY-NNNN`" acknowledgement. One-time only (guarded so reprocessing never re-sends).
- **Never autorespond to quarantined/unknown senders** (D3 + backscatter protection). A legit new customer who emails in gets silence until a tech converts the quarantine — accepted tradeoff.
- **Loop prevention (non-negotiable):**
  - Set `Auto-Submitted: auto-replied` on every autoresponse.
  - **Skip** sending to any sender whose inbound mail carried `Auto-Submitted` (not `no`), `Precedence: bulk/list/junk`, or a `no-reply@`/`mailer-daemon@`/`postmaster@` local-part.
  - Drop mail whose sender is our own `tickets.<domain>` (self-loop guard).
  - Per-sender autoresponse rate cap (Redis sliding window) to bound runaway exchanges.

## 6. Security & Tenancy

- Webhook is HMAC-verified, no session auth, rate-limited (reuse the existing rate-limit helper). Raw body is read before parsing for signature stability in Hono.
- **Partner resolved strictly from the recipient; all sender-supplied data untrusted** — no partner/org inference from `From`.
- `(partner_id, provider_message_id)` uniqueness = idempotency against provider retries and at-least-once queue delivery.
- Quarantine (D3) is the abuse backstop: a stranger emailing a valid partner address cannot create a ticket, only a reviewable `quarantined` row.
- Worker runs **outside request DB context** — `runOutsideDbContext(() => withSystemDbAccessContext(...))` for cross-boundary lookups, honoring the txn pool-poison rule (`project_dbcontext_txn_pool_poison`). Writes go through `ticketService` under a partner-scoped context.
- Internal-note leak regression test extended to the outbound composer (an internal comment must never appear in an outbound email).

## 7. Settings UI

`Settings → Ticketing` gains an **Inbound Email** card (Astro page + React island, same pattern as the existing ticketing settings tabs):
- Enable toggle; display the partner's inbound address (copyable, derived from slug, overridable for self-hosted).
- Default triage org picker (stored, reserved for future use; labelled accordingly).
- Autoresponder toggle.
- **Review queue:** list `quarantined` + `failed` `ticket_email_inbound` rows (from-address, subject, status, time) with a one-click **Convert to ticket** action (picks org, creates `source:'email'` ticket, links the inbound row) and a **Dismiss** action.

All mutations route through `runAction`; new handlers enrolled in `no-silent-mutations` (or allowlisted with inline error UI per the documented exception).

## 8. AI Tools

No new AI tools this phase. Inbound processing is an event-driven backend path, not an agent action. (The existing `create_ticket` / `add_ticket_comment` tools already let an agent do programmatically what inbound email does.)

## 9. Testing

Per `breeze-testing` conventions:
- **Integration (real driver):** worker parse pipeline across all five `parse_status` paths (matched / created / quarantined / failed / ignored); idempotency on duplicate `(partner_id, provider_message_id)`; concurrent ticket-number sequence allocation on burst inbound; RLS coverage for `ticket_email_inbound` (forged cross-partner insert as `breeze_app` must fail).
- **Unit:** Mailgun HMAC verify (valid/invalid/expired timestamp); thread-key extraction (header path + subject-token fallback); loop-prevention header logic (each suppression rule); autoresponder one-time guard.
- **Regression:** internal-note leak on the outbound composer; portal route never exposes email-sourced internal data (none should exist, but assert).

## 10. Explicitly Out of Scope (v1)

Second inbound provider (Resend) beyond the interface; attachment **storage** into ticket file storage (v1 records attachment metadata only — storage is a separate sub-project touching the files layer); HTML→markdown rich rendering (store raw HTML, render plain text); per-org inbound addresses; "accept unknown senders into triage org" auto-create mode (the `defaultTriageOrgId` plumbing is laid but gated off); customer-satisfaction surveys; native↔PSA bidirectional sync. All have §8a-compatible extension paths and none require core-table changes later.

## 11. Implementation Phasing (PR chain)

1. **Schema + provider abstraction** — `ticket_email_inbound` migration + RLS + allowlist; `services/inboundEmail/` interface + `MailgunInboundProvider` + unit tests.
2. **Webhook route + worker** — `POST /webhooks/tickets/email-inbound`, `inboundEmailWorker`, partner/thread resolution, matched/created/quarantined dispatch, idempotency; integration tests.
3. **Outbound threading + autoresponder** — threading headers in the notify-worker email, autoresponder, loop-prevention suppression rules; regression tests.
4. **Settings UI** — Inbound Email card + review/dead-letter queue + Convert-to-ticket; `no-silent-mutations` enrollment.

## 12. Reference Files

- Parent design: `docs/superpowers/specs/2026-06-09-native-ticketing-design.md` (§3 notifications, §4 email-to-ticket, §8 phasing, §8a extensibility)
- Outbound email: `apps/api/src/services/email.ts`
- HMAC pattern: `apps/api/src/workers/webhookDelivery.ts`
- Ticket service: `apps/api/src/services/ticketService.ts` (`createTicket`, `addTicketComment`)
- Notify worker (outbound hook): `apps/api/src/jobs/ticketNotifyWorker.ts`, events in `apps/api/src/services/ticketEvents.ts`
- Schema: `apps/api/src/db/schema/portal.ts` (tickets/comments), `apps/api/src/db/schema/orgs.ts` (partners.slug/settings)
- RLS contract: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
