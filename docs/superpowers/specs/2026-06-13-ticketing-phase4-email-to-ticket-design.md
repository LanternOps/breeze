# Ticketing Phase 4 — Email-to-Ticket Design

**Status:** Approved design (2026-06-13). Next: implementation plan via writing-plans.

**Goal:** Close the original native-ticketing roadmap (`docs/superpowers/specs/2026-06-09-native-ticketing-design.md` §8, phase 4). Inbound email creates/updates tickets; technician replies email the requester with proper threading; new email-tickets get a one-time autoresponse. Provider-abstracted, Mailgun Routes as the first concrete impl.

**Prerequisite state (already shipped):** Phase 1 landed the ticket-side hooks this design builds on — `ticket_source` enum already includes `'email'`; `tickets.email_message_id` / `tickets.email_thread_key` columns exist; `tickets.submitter_email` / `submitter_name` exist; `ticket_comments.author_name` / `author_type` exist (for attributing non-portal senders). `partners.slug` is unique (drives the inbound address); `partners.settings` JSONB holds config. The outbound `services/email.ts` already abstracts Resend/SMTP/Mailgun. The `ticketNotifyWorker` already emails `submitterEmail` on public comments. **Net-new in this phase:** the `ticket_email_inbound` table, the inbound provider abstraction + webhook route + worker, outbound threading headers, the autoresponder, and the Settings → Inbound Email UI.

**Decisions locked during brainstorming (2026-06-13):**
- **D1 — Scope:** full loop + autoresponder (inbound pipeline + threaded outbound replies + one-time acknowledgement on email-created tickets).
- **D2 — Provider:** build a provider-agnostic inbound abstraction, ship **one** concrete impl (Mailgun Routes). Second provider (Resend Inbound) is interface-only this phase.
- **D3 — Unknown senders:** quarantine for review — do NOT auto-create a ticket from a sender that doesn't match a known portal user. Surface in a dead-letter/review queue with a Convert-to-ticket action.
- **D4 — Addressing (Model A in v1):** a single shared **platform** receiving domain on the one global Mailgun account; each partner gets `{partner-slug}@tickets.<platform-domain>` (self-hosted: a per-partner configured address). Partners who want their own customer-facing address **forward** their support mailbox to it — no per-partner DNS/Mailgun automation in v1. Partner resolved strictly from the recipient (To/envelope); sender untrusted.
- **D5 — Custom branded domains (Model B) deferred, seam built now:** per-partner branded inbound domains (`tickets.theirmsp.com`) with a Mailgun-domain provisioning + DNS-verification wizard are **out of scope for v1**. But the `partner_inbound_domains` table and the `resolvePartnerByRecipient()` resolver are built now (empty/platform-only in v1) so Model B is a pure add-on that never touches the webhook or worker (see §2, §10, §11).

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

New config/env: `TICKETS_INBOUND_DOMAIN` (e.g. `tickets.example.com` — the shared platform receiving domain), `MAILGUN_INBOUND_SIGNING_KEY` (HMAC verification key for inbound routes — distinct from the outbound `MAILGUN_API_KEY`).

**Model-B seam — new table `partner_inbound_domains` — Shape 3 (partner-axis).** Built in v1 (RLS + allowlist) but written/managed only by the deferred custom-domain wizard; in v1 it stays empty and the resolver falls back to the platform slug address. Columns: `id`, `partner_id` (not null → partners, RLS axis), `domain` (unique — e.g. `tickets.theirmsp.com`), `provider`, `provider_domain_id` (Mailgun domain handle), `verification_status` (`'pending' \| 'active' \| 'failed'`), `dns_records` jsonb (records to display for verification), `created_at`, `verified_at` nullable. Indexes: unique `(domain)`, `(partner_id)`. Existence of this table is what lets `resolvePartnerByRecipient()` (§4) check custom domains first, then the platform slug — so Model B drops in without a worker/webhook change.

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

All matching/resolution happens through **`resolvePartnerByRecipient(recipient) → partnerId | null`** — the single chokepoint that establishes tenant identity. Everything downstream is scoped to that one `partnerId`; **every** resolution query below carries an explicit `partner_id = :resolvedPartnerId` predicate (see §6 for why app-scoping is mandatory here, not optional).

- **Partner resolution:** recipient address (`to` / envelope-to) → `resolvePartnerByRecipient`: (1) exact match in `partner_inbound_domains` (Model-B seam; empty in v1), then (2) the platform slug address `{slug}@TICKETS_INBOUND_DOMAIN`. Resolves to **exactly one** partner or null → `parse_status='ignored'`. Sender is never used to infer partner/org.
- **Thread key (partner-scoped):** prefer `In-Reply-To` / `References` matched against `tickets.email_thread_key` **filtered to the resolved `partner_id`**; fallback to a `[T-YYYY-NNNN]` subject token, also resolved **within the partner** (ticket numbers are per-partner sequences, so `T-2026-0001` exists for every partner — an unscoped token match would hit the wrong tenant). The matched ticket's `partner_id` is re-asserted before any write; a mismatch is treated as no-match, never a cross-tenant append.
- **Reopen rules (carried from parent §4):** matched reply to a `resolved` ticket reopens it to `open`; a `closed` ticket is immutable — create a new ticket **linked** to the old one instead.
- **Org resolution for new tickets (known sender):** sender email → `portal_users` lookup **scoped to the resolved partner** → that user's org; the resolved org's `partner_id` is re-asserted to equal the resolved partner. (A portal user with the same email under a *different* partner must not match.) The `defaultTriageOrgId` setting exists for a future "accept unknown into triage" mode but is NOT used to auto-create in v1 — unknown senders quarantine per D3.
- **Attribution:** sender matched to a (partner-scoped) portal user → comment/ticket attributed to that user. Accepted-but-unknown senders (only reachable on the *matched-reply* path, where the partner+ticket are already trusted) → `author_name` = display name, `author_type = 'email'`.
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

## 6. Security & Multi-Tenant Isolation

**Why this section is load-bearing:** inbound email is untrusted external input arriving on a path with **no session/JWT**, so the request-context RLS scoping the rest of Breeze relies on does not apply automatically. The worker runs under `withSystemDbAccessContext` (matching the shipped `ticketSlaWorker` / `ticketNotifyWorker` precedent), which **bypasses RLS** — so isolation here is **app-enforced**, not RLS-enforced, and the app-level checks below are therefore mandatory, not best-effort.

- **Webhook edge:** HMAC-verified, no session auth, rate-limited (reuse the existing rate-limit helper). Raw body read before parsing for signature stability in Hono.
- **Tenant identity from recipient only:** partner is established solely by `resolvePartnerByRecipient` (§4); all sender-supplied data (`From`, `In-Reply-To`, `References`, subject token) is untrusted and used only *within* the already-resolved partner. No partner/org is ever inferred from sender data.
- **App-enforced isolation — two mandatory layers (no RLS net under system scope):**
  1. **Partner-scoped reads:** every resolution/match query (§4) carries an explicit `partner_id = :resolvedPartnerId` predicate, so a cross-tenant match can't be produced in the first place.
  2. **Write-boundary re-assertion guards:** immediately before every write, re-assert the invariant in app code and throw (→ `parse_status='failed'`, never a silent cross-tenant write) on mismatch:
     - append/reopen → assert the matched ticket's `partner_id === resolvedPartnerId`;
     - create → assert the resolved org's `partner_id === resolvedPartnerId`;
     - the `ticket_email_inbound` / `partner_inbound_domains` rows are written with `partner_id = resolvedPartnerId` (no caller-supplied partner).
  This matches how `ticketSlaWorker`/`ticketNotifyWorker` already operate (system context + app-correct scoping). It is a deliberate consistency choice, not an oversight — the guards are the isolation boundary, so they get dedicated cross-partner tests (§9).
- **Required `createTicket` change:** the `source:'email'` variant must accept `submitterEmail`/`submitterName` (today `createTicket` deliberately nulls `submitterEmail` for non-portal sources). Without it, outbound replies/autoresponses have no recipient. This is a small, additive service-layer change carried in this phase.
- **Idempotency:** `(partner_id, provider_message_id)` uniqueness guards against provider retries and at-least-once queue delivery.
- **Quarantine (D3)** is the abuse backstop: a stranger emailing a valid partner address cannot create a ticket, only a reviewable `quarantined` row.
- **DB-context hygiene:** worker honors the txn pool-poison rule (`project_dbcontext_txn_pool_poison`) — `runOutsideDbContext` before establishing a context, no slow work (HTTP/Redis loops) held inside a write transaction.
- **Leak regression:** internal-note leak test extended to the outbound composer (an internal comment must never appear in an outbound email or autoresponse).
- **Contract-test blindspot awareness:** `rls-coverage` only checks that *a* policy exists, not that scoping is correct (cf. the dual-axis / FK-child blindspots). So both new tables get **functional cross-partner forge tests** as `breeze_app` (§9), and the worker gets a **cross-partner integration test** (forge an inbound email whose `References`/subject token point at partner B's ticket while addressed to partner A → must NOT touch B's ticket; must create/quarantine under A only).

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
- **Integration (real driver):** worker parse pipeline across all five `parse_status` paths (matched / created / quarantined / failed / ignored); idempotency on duplicate `(partner_id, provider_message_id)`; concurrent ticket-number sequence allocation on burst inbound.
- **Tenant isolation (functional, as `breeze_app` — not just contract):** forged cross-partner insert on `ticket_email_inbound` AND `partner_inbound_domains` must fail with an RLS violation (the contract test only proves a policy exists — cf. dual-axis/FK-child blindspots, §6). Plus a **cross-partner worker test**: an inbound email addressed to partner A whose `References`/subject token reference partner B's ticket must NOT append to, reopen, or read B's ticket — the partner-scoped match query returns nothing for A, and the write-boundary guard (§6) throws → the email resolves within A only (create or quarantine), B's ticket is untouched.
- **Unit:** Mailgun HMAC verify (valid/invalid/expired timestamp); `resolvePartnerByRecipient` (custom-domain hit, platform-slug hit, no-match→ignored, same-slug-different-partner isolation); thread-key extraction (header path + subject-token fallback, both partner-scoped); loop-prevention header logic (each suppression rule); autoresponder one-time guard.
- **Regression:** internal-note leak on the outbound composer; portal route never exposes email-sourced internal data (none should exist, but assert).

## 10. Explicitly Out of Scope (v1)

**Model B — per-partner branded custom inbound domains** (Mailgun-domain provisioning via the Admin API, DNS-record display, verify-polling wizard, Route lifecycle per domain): the `partner_inbound_domains` table + `resolvePartnerByRecipient` seam ship in v1, but the wizard, Mailgun Admin API integration, and self-hosted account story are a **separate follow-up phase**. Also out of scope: second inbound provider (Resend) beyond the interface; attachment **storage** into ticket file storage (v1 records attachment metadata only — storage is a separate sub-project touching the files layer); HTML→markdown rich rendering (store raw HTML, render plain text); per-org inbound addresses; "accept unknown senders into triage org" auto-create mode (the `defaultTriageOrgId` plumbing is laid but gated off); customer-satisfaction surveys; native↔PSA bidirectional sync. All have §8a-compatible extension paths and none require core-table changes later.

## 11. Implementation Phasing (PR chain)

1. **Schema + provider abstraction** — `ticket_email_inbound` + `partner_inbound_domains` (Model-B seam) migration + RLS + allowlist + functional cross-partner forge tests; `services/inboundEmail/` interface + `MailgunInboundProvider` + `resolvePartnerByRecipient` + unit tests.
2. **Webhook route + worker** — `POST /webhooks/tickets/email-inbound`, `inboundEmailWorker`, partner-scoped thread/org resolution, mandatory partner-scoped write context, matched/created/quarantined dispatch, idempotency; integration + cross-partner isolation tests.
3. **Outbound threading + autoresponder** — threading headers in the notify-worker email, autoresponder, loop-prevention suppression rules; regression tests.
4. **Settings UI** — Inbound Email card + review/dead-letter queue + Convert-to-ticket; `no-silent-mutations` enrollment.

## 12. Reference Files

- Parent design: `docs/superpowers/specs/2026-06-09-native-ticketing-design.md` (§3 notifications, §4 email-to-ticket, §8 phasing, §8a extensibility)
- Outbound email: `apps/api/src/services/email.ts`
- HMAC pattern: `apps/api/src/workers/webhookDelivery.ts`
- Ticket service: `apps/api/src/services/ticketService.ts` (`createTicket`, `addTicketComment`)
- Notify worker (outbound hook): `apps/api/src/jobs/ticketNotifyWorker.ts`, events in `apps/api/src/services/ticketEvents.ts`
- Schema: `apps/api/src/db/schema/portal.ts` (tickets/comments), `apps/api/src/db/schema/orgs.ts` (partners.slug/settings)
- DB context helpers (partner-scoped write context + system-context reads): `apps/api/src/db/index.ts` (`withDbAccessContext`, `withSystemDbAccessContext`, `runOutsideDbContext`)
- RLS contract + tenancy shapes: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`; tenancy-shape reference in `CLAUDE.md` (Shape 3 partner-axis)
