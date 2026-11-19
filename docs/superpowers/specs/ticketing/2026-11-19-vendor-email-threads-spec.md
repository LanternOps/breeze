---
issue: 12234
status: approved (decisions approved 2026-11-19)
area: ticketing
date: 2026-11-19
---

# Vendor email threads on a ticket — spec

Refs #12234. Related, not a substitute: #4613 (watchers / CC), #8758 (email-first ticketing).

## 1. Problem

A technician working a ticket often needs a third party: a hardware vendor's
warranty desk, a carrier, a software publisher's support queue. Today they
leave Breeze, email from their own mailbox, and paste the outcome back as an
internal note by hand. The ticket loses the conversation, the audit trail, and
the attachments.

What exists on `main` (verified 2026-11-19):

- **Outbound.** A public reply is mailed only to `tickets.submitter_email`
  (`apps/api/src/jobs/ticketNotifyWorker.ts:540`). The composer has no To, CC or
  BCC. No ticket code reads `contacts` as recipients.
- **Inbound threading.** `findTicketInPartner`
  (`apps/api/src/services/inboundEmail/threadMatcher.ts:238`) matches on
  In-Reply-To/References against `tickets.email_thread_key`,
  `tickets.email_message_id` or a `ticket_email_links` row, then on a subject
  token. A match is **rejected** unless the sender is bound to the ticket
  (requester snapshot, the submitting portal login, or the requester contact,
  `:123`), or, for header matches only, is a prior participant (`:162`: sender or
  CC of accepted inbound mail on the ticket, or the assigned technician). A
  vendor reply therefore does not thread today. It falls to the unknown-sender
  policy (review queue by default).
- **Inbound comments are always public.** `insertEmailAuthoredComment`
  (`apps/api/src/services/inboundEmail/emailComments.ts:32`) hard-codes
  `isPublic: true`. The spec invariant is that "email can never create an
  internal note".
- **Loop rules run before matching.** `ticketCreationLoopReason`
  (`loopPrevention.ts:146`) drops `Auto-Submitted: auto-replied` and null
  Return-Path mail before any match. A vendor's "case 12345 opened"
  acknowledgement is discarded today.
- **Connected mailbox send.** On a connected Microsoft 365 mailbox, customer mail
  goes out through Graph (`graphReplySender.ts`). `resolveOutboundMailbox`
  (`resolveOutboundMailbox.ts:41`) replies to the **latest m365 inbound row on
  the ticket**. `sendNewMail` takes one `to` and no CC, attachments or headers.
  Google Workspace mailboxes are inbound-only: `googleMailboxClient.ts` has no
  send function.
- **Platform transport.** `EmailService.sendEmail` accepts `cc` and
  `attachments`. The Mailgun branch does not forward `cc` (`email.ts:590`). There
  is no BCC anywhere.
- **Partner resolution** (`resolvePartner.ts:7`) matches the exact local part on
  `TICKETS_INBOUND_DOMAIN`. A custom inbound domain resolves on the domain alone.
  There is no plus-address handling.

## 2. Users and scope

- **Actor:** a partner technician with ticket write access to the ticket's
  organization. Customers (portal users) never start or see a vendor thread.
- **Recipient:** any external address. Not a Breeze user, not necessarily a
  contact.
- **Level:** the thread and its messages belong to one ticket, so they are
  org-scoped transactional data, like `ticket_comments`. The vendor directory
  (§4.7) is config and follows partner-wide-first (`partner_id` XOR `org_id`).
- **Distinct from #4613:** watchers are customer or staff people who follow the
  ticket's public/internal split. A vendor thread is a separate, internal
  conversation with its own recipients. Adding a watcher never creates a vendor
  thread, and a vendor never becomes a watcher.

## 3. Goals and non-goals

Goals:

1. Send from the ticket to one or more external addresses (To + CC), with
   attachments already on the ticket.
2. Vendor replies, including the vendor's automatic case acknowledgement, land on
   the same ticket as **internal** notes and never email the requester.
3. Every send and every received vendor message is on the ticket and in the
   audit log (who, to whom, when, visibility, attachments).
4. A spoofed or guessed reply cannot write into a ticket. Vendor mail can never
   become a customer-visible comment, and it can never make the vendor a
   participant in the customer thread.

## 4. Proposed design

### 4.1 Concepts

- **Vendor thread** (`ticket_vendor_threads`): one conversation between the
  partner and one or more external parties about one ticket. It has a subject, a
  status (`open` | `closed`), a per-thread reply token, and the set of external
  addresses it has written to. A ticket can have several threads (warranty desk
  and carrier at the same time).
- **Vendor message** (`ticket_vendor_messages`): one outbound or inbound email on
  a thread. It points at the internal `ticket_comments` row that shows it in the
  timeline and records the envelope: from, to[], cc[], Message-ID, the transport
  used, and delivery state.

The timeline shows vendor messages as internal notes with a "Vendor email" badge,
grouped by thread, with the recipients shown.

### 4.2 Outbound

`POST /tickets/:id/vendor-threads` (new thread) and
`POST /tickets/:id/vendor-threads/:threadId/messages` (follow-up) take
`{ to: string[], cc: string[], subject?, body, attachmentIds: uuid[] }`.

1. **Authorize:** access to the ticket's org, a dedicated permission
   (`tickets.vendor_email`, Decision 8), the feature enabled (§4.9), and
   the partner passes the sending gate (§4.8).
   **Thread binding:** every route that takes a thread id (follow-up, close,
   and the §4.6 file and approve-sender actions) loads the thread by
   `(thread.id, thread.ticket_id = path ticket, thread.org_id = ticket org)`
   and applies the full ticket authorization to the path ticket, including
   the application-layer site scope that org RLS does not enforce. A thread
   that belongs to another ticket, including one the caller cannot see, is a
   404. The composite FK in §5 makes the same pairing structural for messages.
2. **Recipients are exactly what the technician chose.** They are never copied
   from an inbound message's Reply-To, From or CC. A follow-up defaults to the
   thread's stored recipient set. The technician may add a verified vendor
   replier (§4.4) with one click; it is never added silently.
3. **Validate:** each address is syntactically valid and is not on the partner's
   inbound or sending domains. The requester address and portal users of the
   ticket's org are refused with a clear error, because putting the customer on a
   vendor thread makes the internal conversation customer-visible by email (see
   Decision 4). Limits: 10 recipients per message, 25 distinct recipients
   per thread.
4. **Write, in one transaction:** an internal `ticket_comments` row
   (`is_public = false`, `author_type = 'internal'`, attributed to the
   technician), a `ticket_vendor_messages` row (`direction = 'outbound'`,
   `delivery_state = 'queued'`), the attachments joined to the comment, and an
   outbox job. Emit `ticket.commented` with `isPublic: false`, so only the staff
   paths react.
5. **Send** from a worker (`ticketVendorMailWorker`), never from the request:
   - **Message-ID:** minted as `<ticket-{ticketId}-vm-{messageId}@{inbound domain}>`
     on the platform lane. This is the existing `outboundMessageIdPattern` shape,
     so an echo of our own message is dropped by `ownOutboundReason`. It is
     recorded on the message row and in `ticket_email_links` with
     `origin = 'vendor_outbound'`, `visibility = 'internal'` **before** the send.
   - **Threading headers:** In-Reply-To/References chain only this thread's own
     Message-IDs. They **never** carry the ticket's customer anchor
     (`email_thread_key`).
   - **Reply-To:** the partner's inbound address with the thread's reply token as
     a sub-address (`{localPart}+v{token}@{domain}`; §4.3).
   - **Subject:** the technician's subject followed by `[T-YYYY-NNNN]` for human
     reference. The token is not used for matching (§4.3).
   - **Transport**, chosen once per message and stored:
     1. **Connected Microsoft 365 mailbox:** sent from that mailbox through Graph
        as a **new** message, never a `createReply`: create a draft (request
        immutable ids) with explicit to/cc and attachments (upload sessions above
        3 MB), persist the draft id, send once, then read the Sent Items copy for
        its `internetMessageId` and record it. An ambiguous send (timeout after
        the send call) is reconciled against Sent Items before any retry, so a
        vendor never gets the message twice. The vendor sees the partner's real
        support address. `resolveOutboundMailbox` is not used, because it replies
        to the latest inbound row. *Not checked:* that the Sent Items copy is
        readable promptly in every tenant; the Graph wave must prove it.
     2. **Partner lane:** a new purpose `ticket.vendor_message`
        (`lane: 'partner', stream: 'support'`), sent from the partner's verified
        sending domain. Today `resolveSender` falls back to the platform lane on
        every partner-lane miss, including the daily cap
        (`emailDomains/senderResolution.ts:163`). This purpose must **hold**
        instead: the message is marked `failed` with the reason shown, never sent
        from the platform domain (Decision 6).
     3. **Neither available:** the composer is disabled with an explanation. A
        Google Workspace mailbox has no send path today (Decision 6).
   - **CC on Mailgun:** the plan fixes the dropped `cc` at `email.ts:590` (already
     tracked there as "its own issue") before this ships. Graph drafts take
     `ccRecipients` natively.
6. **Delivery state** (`queued` → `sent` | `failed`) is shown on the message.
   A failure is an internal timeline event and an assignee notification. It is
   never retried after a definitive provider rejection.

### 4.3 Reply matching

Vendor matching is a **separate matcher that runs before the customer matcher**,
inside the existing pipeline, after the R4 sender-authentication gate.

A message is a vendor-thread candidate on either of two signals:

| Signal | Source | Strength |
|---|---|---|
| **Reply token** in a recipient address: `+v{token}` on To/Cc/Delivered-To, the platform envelope recipient, or Graph `toRecipients`/`ccRecipients` | Reply-To we set | 128-bit random, unguessable; survives vendor systems that strip headers but answer the Reply-To |
| **Header match**: In-Reply-To/References names a Message-ID recorded with `origin IN ('vendor_outbound','vendor_inbound')` | `ticket_email_links` | Exact; survives a vendor that keeps headers but replies to From instead of Reply-To |

The subject token is **not** a vendor signal. Subject tokens are enumerable,
which is why the customer matcher binds them to the requester.

**Sender binding (required in addition to a signal):**

1. The R4 gate already requires an authenticated From (DMARC pass or aligned
   SPF+DKIM). That is unchanged: an unauthenticated vendor reply is quarantined
   like any other.
2. The From address is on the thread's **approved sender list**: every
   address the thread has written to, plus any address a technician approved
   for this thread (§4.6).
3. **Same-domain senders (Decision 2):** vendor case systems often answer
   from a different mailbox on the recipient's domain (`cases@` for a message
   sent to `support@`). Recommended rule: a same-domain sender is auto-filed
   only when the **reply token** matched, because the token is a secret that was
   only sent to that vendor. A header-only match from a same-domain sender goes
   to review. Subdomains never count, and free-mail domains (a fixed list) are
   address-only.
4. Anything else that carries a vendor signal (a forward to a colleague on
   another domain, a reply whose references name two threads) goes to the review
   queue with a reason prefixed `vendor thread:`. It never falls through to the
   customer matcher or to unknown-sender ticket creation.

**Store the token as a SHA-256 hash.** It is a capability, so the database holds
the hash and the token is only ever in outbound mail.

**Precedence and isolation rules (all enforced in code and tests):**

- A message that matches a vendor thread is handled by the vendor path and **never**
  falls through to `findTicketInPartner`, even when it also matches the customer
  thread (a vendor reply-all that includes the requester's anchor).
- `findTicketIdsByMessageIds` (`ticketEmailLinks.ts:133`) ignores `visibility` and
  `origin` today. The customer matcher must exclude `vendor_*` origins, or a
  vendor Message-ID becomes a customer-thread header match.
- **Invariant (vendor-origin status):** every path that writes a
  `ticket_email_inbound` row for a vendor-origin message records it as
  `vendor_matched` (attributed to the ticket) or as a review status with
  `ticket_id = null`. It never records `matched` or `created` against the
  ticket. A message is vendor-origin when it carried a vendor signal, or when its
  Message-ID is claimed by a `ticket_email_links` row with a `vendor_*` origin.
  The paths, each named so none is missed:
  1. **Vendor matcher** (this section): `vendor_matched`.
  2. **Claimed-link fast path (step 2b,
     `inboundEmailService.ts:401`):** it runs before the sender-auth gate and
     before this matcher, and today writes `matched` for any claim. The claim's
     `origin` decides the status: a `vendor_*` claim is recorded as
     `vendor_matched`, any other claim as `matched` (unchanged). This path is how
     a vendor message CC'd to both the platform inbound address and a connected
     mailbox is filed once, so without this rule the second copy, in either
     delivery order, would become a customer-thread row.
  3. **Automatic replies and bounces** (§4.4): `vendor_matched`.
  4. **Review queue** (§4.6): rows with a `vendor thread:` reason are written
     with `ticket_id = null` (as quarantine rows are today). **File to vendor
     thread** moves the row to `vendor_matched`. `Convert` mints a new ticket
     (`created` on that new ticket only) and is unchanged.
  5. **Outlook add-in fast paths** (`routes/officeAddin/tickets.ts:608`, `:821`)
     write no inbound row. On a `vendor_*` claim they return the existing link
     and never link the message as a customer comment.
- **Readers key on the vendor state, not on status alone.** Both readers below
  use an allowlist of customer statuses (`matched` / `created`) **and** exclude
  any row whose Message-ID has a `vendor_*` link row, so the arrival order of two
  copies, or a row written before this feature, cannot change the outcome:
  - `senderIsThreadParticipant` (`threadMatcher.ts:178`): a vendor never becomes
    a customer-thread participant.
  - `resolveOutboundMailbox` (`ticketMailbox/resolveOutboundMailbox.ts`): today
    it takes the latest `m365` row on the ticket with no status filter. It gains
    the same allowlist and exclusion, so the next customer reply is never a Graph
    `createReply` to a vendor's message.
  - `markIngestedGmailHandled` treats `vendor_matched` as handled (added to
    `TICKETED_STATUSES`), so a filed vendor message is not re-ingested.

**Sub-address parsing:** `resolvePartnerByRecipient` strips a `+…` suffix before
the local-part match on the platform domain. Custom inbound domains already
resolve on the domain. *Not checked:* that the platform inbound provider routes
arbitrary sub-addressed local parts to the webhook, and whether sub-addressing is
on in a given Exchange Online tenant. When the token does not survive, the header
signal still works. The plan's first inbound wave must prove each lane.

### 4.4 Inbound handling of a vendor match

- **Comment:** a new writer `insertVendorEmailComment`, not
  `insertEmailAuthoredComment`: `is_public = false`, `author_type =
  'vendor_email'`, `user_id = null`, `author_name` = the verified From address
  (display name shown only as an annotation, never as identity). It is
  **always internal**, whatever the outbound visibility. The invariant becomes:
  *email from a customer creates public comments only; email from a vendor thread
  creates internal notes only.*
- **Attachments:** persisted through `persistInboundAttachments` against the
  internal comment. *To verify in the plan:* every attachment read path (portal,
  partner API, AI tools) follows the parent comment's `is_public`, so a vendor
  attachment is never customer-visible.
- **Events:** `ticket.commented` with `isPublic: false, inbound: true, vendor: true`.
  It notifies the assignee (or the queue when unassigned) and writes the outbox
  row with `isPublic: false`. It never notifies the requester.
- **Status:** a vendor reply does **not** reopen a resolved ticket or change
  status. It sets `tickets.vendor_reply_pending_at` so the queue can show "vendor
  replied". Opening the ticket clears it. It does not stop or satisfy any SLA
  clock (first response and resolution measure the customer conversation).
- **Closed ticket:** no continuation ticket. The message goes to the review queue
  with reason `vendor thread: ticket closed`.
- **Merged ticket:** the thread follows the survivor. Merge re-points
  `ticket_vendor_threads.ticket_id`, and the matcher resolves through
  `merged_into_ticket_id` the same way the customer matcher does.
- **Closed thread:** a reply to a thread a technician closed still files to the
  ticket (it is the ticket's history) and re-opens the thread. A thread is closed
  only for display; it does not change matching.
- **Automatic replies:** `Auto-Submitted: auto-replied` mail that carries a vendor
  signal is filed as an internal note marked `auto` with no notification, instead
  of being dropped. This is safe because an internal note sends no mail, so it
  cannot start a loop. A null Return-Path bounce with a vendor signal marks the
  original outbound message `failed` with the bounce text. All other loop rules are
  unchanged.
- **Ledger:** the reply's own Message-ID is claimed in `ticket_email_links` with
  `origin = 'vendor_inbound'`, so the next hop threads even if a client trims
  References.

### 4.5 Visibility and sharing with the customer

Vendor threads are internal, with no per-thread visibility switch in v1. When the
customer should learn something from the vendor, the technician writes a public
reply. The composer offers **Quote into reply**, which copies the selected vendor
note's text into a public draft for the technician to edit. Nothing vendor-authored
becomes public without a technician posting it. See Decision 4.

### 4.6 Review queue

The existing queue (`ticket_email_inbound` quarantined/failed) gains a
**File to vendor thread** action for rows whose reason starts with
`vendor thread:`. It files the message once, as the same internal note as §4.4.
A separate **Approve sender for this thread** control adds the exact address to
the thread's approved sender list, so later replies from it file automatically.
Filing once never approves the sender. `Convert` (new ticket) stays available but is not the default for
these rows.

### 4.7 Vendor directory (Decision 1)

Recommended as the last wave, and cut if the plan runs long. A small
partner-wide list of external contacts, so a technician picks "Hardware vendor —
warranty desk" instead of retyping an address:

- `vendor_contacts`: `partner_id` XOR `org_id`, `name`, `company`, `email`,
  `notes`. Partner rows are visible to every org of the partner. Org rows hold a
  customer-specific account (their own reseller rep).
- **Not `contacts`.** `contacts` holds customer people, and inbound requester
  resolution matches a sender against them (`resolveOrg.ts:129`). A vendor
  stored there would be resolved as a customer of that org when it emails in
  fresh. Keeping vendors in their own table keeps "who is the customer" clean.
- The composer also suggests addresses this partner has recently written to on
  vendor threads (a query over `ticket_vendor_messages`, no new table).
- The directory is a convenience, not an allowlist (Decision 1).

### 4.8 Abuse controls

This feature sends mail to arbitrary addresses from a multi-tenant hosted
service, so the gates are deliberate:

- **Partner state:** available only to partners in the `trusted` trust state on
  hosted. `probation` and `restricted` partners see the feature with an
  explanation. Self-hosted, where trust mode is `off`, is unaffected.
- **Sender identity:** only a verified partner sending domain or a connected
  mailbox. No platform-domain fallback.
- **Caps:** vendor messages count toward the existing partner-lane daily cap
  (`emailDomains/sendCap.ts`). A separate per-partner daily cap on vendor messages
  and on **distinct new vendor recipients** (defaults: 200 messages, 50 new
  recipients per day) sits on top. Graph-lane sends count toward both.
- **Per message:** the recipient limits in §4.2 and the attachment limits in §4.10.
- **Hard bounces:** a recipient that hard-bounces is marked on the thread, and
  later sends to it need an explicit confirm.

### 4.9 Settings

One setting: **Vendor email from tickets** (on/off).

- **Home:** Settings → Ticketing → Email.
- **Level:** partner only. A per-org override has no clear use: a vendor thread
  is the MSP's own conversation, not the customer's.
- **Resolver:** `resolveVendorEmailPolicy(partnerId)` in the ticketing settings
  service, read by the composer, the routes and the worker.
- **Count:** the concept is configured in 0 places before and 1 after.
- **Default:** off on existing partners and on for new partners, behind the
  `TICKET_VENDOR_EMAIL_ENABLED` platform flag for rollout.

### 4.10 Attachments

- Only attachments already on this ticket (`ticket_attachments`, same ticket and
  org), chosen by id. New files are uploaded through the existing ticket
  attachment route first, so the existing rules apply unchanged:
  `TICKET_ATTACHMENT_LIMITS` (`packages/shared/src/constants/ticketAttachments.ts`):
  5 files, 10 MiB each, JPEG/PNG/WebP/PDF.
- An aggregate ceiling on the encoded message (25 MB) is checked before send,
  because base64 grows the payload by a third.
- Inbound vendor attachments use the existing inbound attachment rules.

### 4.11 Audit

`createAuditLog` entries, org-scoped:

- `ticket.vendor_thread.created` and `ticket.vendor_thread.closed`
- `ticket.vendor_message.sent`, with thread id, recipients, transport, attachment
  ids and sizes. The body is not logged.
- `ticket.vendor_message.received`, with thread id, sender, matched signal
  (`token` | `header`) and attachment count.
- `ticket.vendor_message.filed_from_review`
- `ticket.vendor_message.failed`

### 4.12 API, AI and the Partner API

v1 ships the UI and REST routes. The Partner API and AI tools get read access
(vendor notes appear as internal comments with `author_type = 'vendor_email'`).
A write tool ("email the vendor") is out of scope for v1, because an agent
sending mail to arbitrary addresses needs its own approval design.

## 5. Tenancy and data model impact

New org-scoped tables (Shape 1, direct `org_id`, RLS enabled, forced and
policies in the creating migration). They are not config, so the
partner-wide-first default does not apply. They are per-ticket transactional
rows like `ticket_comments`.

**`ticket_vendor_threads`**: `id`, `ticket_id`, `org_id`, `partner_id`
(denormalized for partner-scoped matching), `subject`, `status`,
`reply_token_hash` (unique), `recipient_addresses text[]`,
`approved_sender_addresses text[]`, `created_by`,
`created_at`, `closed_at`. Composite FK `(ticket_id, org_id) → tickets(id,
org_id)` `DEFERRABLE INITIALLY IMMEDIATE`. `UNIQUE (id, ticket_id, org_id)`, the
target of the message FK below.

**`ticket_vendor_messages`**: `id`, `thread_id`, `ticket_id`, `org_id`,
`partner_id`, `comment_id`, `direction`, `message_id`, `from_address`,
`to_addresses text[]`, `cc_addresses text[]`, `transport` (`graph` |
`partner_lane` | `inbound`), `delivery_state`, `delivery_error`, `matched_signal`,
`auto_submitted bool`, `created_by`, `created_at`. One composite FK
`(thread_id, ticket_id, org_id) → ticket_vendor_threads(id, ticket_id, org_id)`
`DEFERRABLE INITIALLY IMMEDIATE`: every message is paired with its thread, and a
message that names a different ticket than its thread cannot exist. Plus the
composite FK `(ticket_id, org_id) → tickets(id, org_id)`, also `DEFERRABLE
INITIALLY IMMEDIATE`. Because of the triple FK, ticket merge, ticket move and org
move re-point `ticket_id` / `org_id` on the thread **and** its messages in one
transaction with the constraints deferred. `text[]` rather than jsonb so the rows
survive tenant export.

**`vendor_contacts`** (per Decision 1): `partner_id` XOR `org_id` with a CHECK, dual-axis read
policy (partner-wide rows readable by the partner's org-scoped users, SELECT-only;
writes gated by `canManagePartnerWidePolicies` for partner rows). Follow the
#2135 playbook in `docs/agents/tenancy-rls.md`.

Registration (grep, don't judge):

| List | `ticket_vendor_threads` | `ticket_vendor_messages` | `vendor_contacts` |
|---|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` | yes | yes | yes (org rows) |
| `orgMergeRegistry.ts` | repoint | repoint | repoint |
| `CORE_TENANT_EXPORT_POLICY` | classify every column | classify every column | classify every column |
| `TICKET_ORG_DENORMALIZED_TABLES` + `CUSTOM_ORG_REWRITE_TABLES` (same relative order; runtime-only check) | yes | yes | n/a |
| Ticket merge re-point | yes | yes (own `ticket_id`, same transaction as the thread, constraints deferred) | n/a |
| Partner-axis allowlist (`partner_id` rows) | n/a | n/a | yes |

Changes to existing tables:

- `ticket_email_links.origin` CHECK gains `vendor_outbound` and `vendor_inbound`.
  The customer-thread lookup excludes them.
- `ticket_email_inbound.parse_status` gains `vendor_matched`. The review-queue
  reasons gain the `vendor thread:` prefix (text only).
- `tickets.vendor_reply_pending_at timestamptz` is new. It needs an export-policy
  classification because `tickets` is an org-cascade table.
- `ticket_comments.author_type` gains the `vendor_email` value (app vocabulary,
  varchar).

The migration follows `apps/api/migrations/README.md`: name it after the newest
migration, keep it idempotent, and add no row writes (so no system scope).

## 6. Out of scope (v1)

- BCC. A BCC'd party who replies cannot be bound to the thread without storing
  them, and storing them defeats BCC.
- Making a vendor thread customer-visible, or putting the requester on it.
- Sending from a Google Workspace mailbox (no send path exists).
- An AI or Partner API write action that emails a vendor.
- Parsing vendor case numbers into structured fields (vendor RMA tracking).
- Inline editing of the vendor directory from the composer, beyond "save this
  address".
- Bounce parsing beyond marking a null-Return-Path reply on a known thread.

## 7. Decisions (approved 2026-11-19)

Todd approved all nine as recommended. Where Codex dissented, the dissent is noted.

1. **Vendor directory:** a partner-wide `vendor_contacts` table (`partner_id` XOR `org_id`) plus recent-recipient suggestions, shipped as the last wave (W5) so it can be cut. *Codex dissent: recent recipients only; the disagreement is on cost, not safety.*
2. **Same-domain vendor senders:** auto-file only when the secret reply token matched; header-only matches need the exact approved address. *Codex preferred exact-address only.*
3. **Reply token transport:** per-thread token as a Reply-To sub-address (`support+v{token}@…`), with header matching as the fallback. Lanes that cannot carry the token run on headers alone (§8 rollout step 3).
4. **Customer on a vendor thread:** no in v1. The requester and portal users are refused as recipients, threads stay internal, and a "Quote into reply" action helps the technician tell the customer.
5. **Vendor reply on a resolved ticket:** no reopen. Set a "vendor replied" marker and notify the assignee; SLA clocks are untouched.
6. **Sending identity without a verified sending domain or connected Microsoft 365 mailbox:** on hosted, refuse (composer disabled with an explanation); self-hosted may use its configured platform From. The over-cap fallback to the platform lane is disabled for this purpose. *Codex preferred the platform From with the partner display name.*
7. **Google Workspace mailbox partners:** vendor mail goes on the partner lane in v1 (or is refused under 6). Gmail send is a follow-up.
8. **Permission:** a dedicated `tickets.vendor_email` permission, granted by default to roles that can write tickets.
9. **Setting level:** partner-level on/off under Settings → Ticketing → Email, with no org override.

## 8. Test and rollout

**Unit (Vitest):**

- Vendor matcher signal × binding matrix: {token, header, both, neither} ×
  {exact recipient, same domain, subdomain, free-mail domain, other domain} ×
  {DMARC pass, fail}.
- A vendor match never reaches `findTicketInPartner`, even when the message also
  carries the customer anchor.
- The customer matcher ignores `vendor_*` link rows.
- `senderIsThreadParticipant` and `resolveOutboundMailbox` ignore
  `vendor_matched` rows, and ignore a `matched` row whose Message-ID has a
  `vendor_*` link row.
- Vendor-origin status invariant, one case per §4.3 path: the vendor matcher,
  the step-2b fast path on a `vendor_*` claim, an automatic reply, a bounce and
  **File to vendor thread** each leave a `vendor_matched` row and no `matched` /
  `created` row on the ticket.
- The dual-delivery pair (webhook copy, then the same Message-ID through the
  connected mailbox, and the reverse order) leaves no `matched` row and no `m365`
  row that `resolveOutboundMailbox` can select, and the vendor is not a
  `senderIsThreadParticipant` match afterwards.
- Thread binding: a follow-up, close, file or approve-sender call with a thread
  id from another ticket returns 404, including a thread on a ticket outside the
  caller's site scope.
- `insertVendorEmailComment` is always `is_public = false`. The event payload
  never reaches the requester branch of `handleTicketEvent`.
- Automatic replies with a vendor signal are filed. Without a vendor signal the
  existing drop is unchanged.
- Outbound: recipients equal the request exactly; the customer anchor is never in
  the headers; the requester or a portal user is refused; caps are enforced and
  a trust-gated partner is refused.
- The Mailgun `cc` fix, with a test that discriminates by failing before the fix.

**Integration (real Postgres; runs only under the Integration Tests job):**

- RLS: a cross-org thread insert fails as `breeze_app`.
- A `ticket_vendor_messages` insert whose `ticket_id` differs from its thread's
  `ticket_id` fails the `(thread_id, ticket_id, org_id)` FK.
- Cascade, merge and export suites with the three tables registered.
- Org move, ticket move and ticket merge re-stamp the thread and its messages
  together, and the deferred triple FK holds at commit.
- End to end: send → inbound reply with token → internal note, no requester email,
  audit rows present.

**E2E (Playwright, `data-testid`):** compose a vendor email, see it in the
timeline as internal; the portal view of the same ticket shows nothing.

**Rollout:**

1. Behind `TICKET_VENDOR_EMAIL_ENABLED` (default off) plus the partner setting.
2. Our own tenant first, on the partner lane, then a connected Microsoft 365
   mailbox.
3. Prove three unchecked assumptions before general availability: Graph
   draft-then-send keeps `internetMessageId`; the platform inbound provider routes
   sub-addressed local parts; Exchange Online tenants deliver `+token` mail.
4. Docs: the Ticketing page gains "Emailing a vendor from a ticket".

**Suggested waves** (the plan will finalize them):

- **W1:** schema + RLS + registration, and the Mailgun `cc` fix.
- **W2:** partner-lane outbound, the composer, and audit.
- **W3:** inbound vendor matcher, internal notes, auto-reply and bounce handling,
  and the review-queue action.
- **W4:** Graph send path.
- **W5:** vendor directory and recipient suggestions.
