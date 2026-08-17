# Outlook Tech Persona — MSP Ticketing in the Breeze Add-in

**Status:** Approved design, pre-implementation
**Date:** 2026-08-15
**Scope:** v1 = ticket association core + time entries. Out of scope v1: AI reply
drafting, historical mailbox backfill (v2 direction recorded at the end), shared
mailboxes, compose-mode actions.

## 1. Product summary

The existing Outlook add-in (`apps/outlook-addin` + `packages/office-addin-core`)
is "Breeze AI for Office" — a chat pane for MSP *client end-users*. This design
adds a second, MSP-**technician**-facing persona to the **same add-in** (same
manifest, same add-in ID, one deployment). When the signed-in user is a bound
Breeze technician, the pane boots a structured ticketing UI instead of the client
chat:

- Reading a customer email: resolve sender → organization + contact candidates,
  show the thread-matched ticket and the org's open/recent tickets, show customer
  context (org summary).
- One-click: link the email to an existing ticket (as a comment) or create a new
  ticket from it, with an AI-drafted subject/summary and threading keys stamped so
  subsequent customer replies auto-thread through the existing inbound pipeline
  (where an inbound path exists — see §8).
- Log time / start-stop a timer against the linked ticket.

Multi-tenancy answer this design rests on: Office manifests are static per
deployment, but all behavior inside the taskpane is decided server-side at token
exchange. One manifest, per-login persona. Per-partner ribbon branding (name/icon)
would require per-partner manifests with distinct add-in IDs — explicitly out of
scope and orthogonal.

## 2. Persona resolution & authentication

### 2.1 Exchange endpoint

New neutral endpoint: `POST /office-addin/auth/exchange`.

The Outlook pane calls it once at boot with the Entra access token (same silent
SSO / MSAL-popup acquisition as today). Server flow:

1. Verify the Entra token once (reusing `clientAiEntraJwt.ts` verification;
   additionally validate delegated `scp` includes `access_as_user` — the current
   verifier checks signature/audience/issuer/tid/oid only, which can admit
   service principals).
2. Look up a technician binding on `(entra_tenant_id, entra_oid)` (§2.2).
3. **Bound and eligible** → mint a tech session (§2.3), return
   `{ persona: 'tech', ... }`.
4. **Bound but denied** (user disabled, offboarded, membership removed, security
   epoch advanced) → **hard deny**. Never fall through to the client resolver —
   falling through would JIT-provision a former technician as a client portal
   user, a privilege-model failure.
5. **No binding** → run the existing client persona resolver internally,
   unchanged, and return the client-session response shape with
   `persona: 'client'`.

`POST /client-ai/auth/exchange` is not modified. Word/Excel/PowerPoint and
already-deployed Outlook clients continue to call it; only the updated Outlook
bundle switches to the neutral endpoint. Same IP rate-limiting posture as the
client exchange.

### 2.2 Technician identity binding

New table `office_addin_user_bindings`:

| column | notes |
|---|---|
| `id` | uuid PK |
| `entra_tenant_id` | uuid, normalized |
| `entra_oid` | uuid |
| `user_id` | FK `users`, the bound technician |
| `partner_id` | FK `partners` NOT NULL (denormalized from the user at bind time; a DB constraint ensures the user belongs to this partner) |
| `mfa_verified_at` | when the binding was established with Breeze MFA |
| `created_at` / `revoked_at` / `revoked_by` | lifecycle |

Constraints: unique `(entra_tenant_id, entra_oid)` among non-revoked rows; unique
active binding per `user_id`.

**Email is never an authorization identifier.** Both the repo's staff SSO
implementation (`routes/sso.ts` — `(provider, external subject)` is authoritative)
and Microsoft guidance forbid email/`preferred_username` for authorization. The
binding is the only path from an Entra identity to a Breeze user.

**Binding creation (one-time, in-pane):** on first sign-in with no binding and no
client mapping — or via an explicit "I'm a technician" entry point — the pane runs
a link flow: silent SSO captures `(tid, oid)`, then the technician confirms with
their Breeze credentials **including MFA**. The server creates the binding stamped
`mfa_verified_at`. This is what makes silent SSO safe afterwards: an SSO exchange
never mints capability by itself; it resumes a binding that was MFA-established.

Binding invalidation: user deactivation/offboarding, partner admin revocation (a
small management list in the web UI under partner settings), and the user's
security-epoch advancing (password reset, forced logout) revoke the binding; the
technician re-links.

Tenancy/RLS: **Shape 3 partner-axis** — `breeze_has_partner_access(partner_id)`
policy, registered in `PARTNER_TENANT_TABLES` in
`rls-coverage.integration.test.ts`, with a cross-partner forge test. No `org_id`
→ no org-cascade or export-policy registration. Managing bindings in the web UI
requires a partner-global admin permission + MFA (RLS alone must not let a
selected-org technician alter authentication configuration).

No tenant→partner registry table is needed for v1: the per-user binding carries
the partner. (`ticket_mailbox_tenant_ownerships` remains what it is — mailbox
tenant ownership — and is not overloaded as an auth authority.)

### 2.3 Tech session token

Opaque Redis session, following the client-ai pattern (`nanoid(48)`,
`SETEX`), in a **separate namespace** (`techaddin:session:<token>`), with:

- Sliding TTL plus an absolute maximum lifetime.
- Payload: `{ userId, partnerId, bindingId, createdAt }` — no capabilities in the
  token; authorization is re-derived per request.
- A per-user session set for bulk revocation (mirroring
  `clientai:user-sessions:*`).

New `officeAddinTechAuthMiddleware`, mounted **only** on `/office-addin` tech
routes. Per request it re-verifies live state (the checks normal `authMiddleware`
performs): active user + partner, security/auth epochs, live partner membership,
accessible-org list and site restrictions, current RBAC permissions, IP allowlist
policy. The add-in capability set (email-context, ticket-create, ticket-link,
time-read, time-write) is **intersected with** live RBAC — it narrows, never
replaces. Handlers run inside `withDbAccessContext` with the technician's real
scope (partner or selected-org), same as web requests.

The token is not a Breeze access JWT and is accepted by nothing else — not
`/api/v1/*`, not `/client-ai/*`.

## 3. API surface — `/office-addin/*`

Thin route adapters that call existing services. The broad `/api/v1/tickets` and
`/api/v1/time-entries` routers are **not** remounted or allowlisted for this
token; they expose far more than v1 needs (bulk approve, timesheets, deletes,
move-org, export).

All request bodies are POST — sender addresses, subjects, Message-IDs and
References never appear in URLs (caches, proxy logs, history).

### 3.1 `POST /office-addin/email-context`

Input: `{ from: {email, name}, sender?: {email, name}, internetMessageId?,
references?: string[], inReplyTo?, subject, conversationId?, itemGeneration }`.

Under send-on-behalf, the **represented `from`** identity drives customer
resolution; `sender` is preserved for provenance only.

Output:
- `org` — resolved via the same chain the inbound pipeline uses: exact-domain
  lookup in `customer_email_domains`, then address-level `portal_users` match
  (partner-scoped). Freemail/ambiguous domains return no org rather than a guess.
- `contacts` — candidate matches from `portal_users` and `contacts` with match
  provenance and confidence. Duplicate emails are legal (shared mailboxes);
  ambiguity is surfaced for the technician to pick, never auto-resolved.
- `threadMatchedTicket` — via the shared matcher (§5): `In-Reply-To` ∪
  `References` against `tickets.email_message_id` / `email_thread_key` /
  `ticket_email_links`, plus the `[T-YYYY-NNNN]` subject-token fallback.
- `openTickets` / `recentTickets` for the resolved org. This requires a new
  "tickets by org + submitter email" query (list search today covers only
  subject + internalNumber) — added as a service-level query, not a public list
  filter.
- `orgSummary` — org name/site count/device count/recent ticket stats, filtered
  to the technician's `accessibleOrgIds`.

Results from partner-axis tables (`customer_email_domains`, inbound ledger) are
explicitly narrowed to `accessibleOrgIds` in the app layer — partner-axis RLS is
flat and does not enforce a selected-org technician's narrower grant.

### 3.2 `POST /office-addin/tickets/from-email`

Creates a ticket from the current message. Semantics mirror the inbound
pipeline's creation path:

- `source = 'email'` (existing enum value; add-in provenance lives in the
  `ticket_email_links` row and audit metadata, not a new source value).
- Stamps `email_message_id` (customer's original Message-ID) and
  `email_thread_key` (generated outbound anchor) exactly as
  `inboundEmailService` does, and dual-writes a `ticket_email_links` row.
- Requester: technician picks a resolved contact, or the raw
  `submitter_email`/`submitter_name` is used. Contact auto-creation is a
  deliberate, technician-confirmed option (a purpose-built creation path — the
  add-in does not silently reuse `findOrCreateEmailContact`, which is non-atomic
  and creates password-less `portal_users` rows as an ingest side effect).
- Subject/description prefilled from the AI draft (§6) or deterministic fallback;
  the technician edits before submit.
- **Idempotent** on the message-id ledger (§4): a retry, double-click, or
  poller race returns the already-created ticket instead of a duplicate.

### 3.3 `POST /office-addin/tickets/:id/link-email`

Appends the current email to an existing ticket.

- **Public link:** uses shared inbound-email comment semantics — an
  email-authored public comment attributed to the customer sender with the
  inbound flag set, so no first-response SLA is stamped for the customer's own
  words and no notification echoes back to the requester. It must NOT go through
  the technician comment service (which marks the author as internal, stamps SLA,
  and notifies).
- **Internal link:** a technician-authored internal note quoting the email.
- Either way, a `ticket_email_links` row records the association — thread
  association is independent of comment visibility.
- Idempotent: same message → same ticket returns the existing link. Same message
  → a **different** ticket returns 409 with the current association (the pane
  offers to open that ticket).
- Linking must respect ticket state via the shared matcher's rules: no silent
  appends to closed or deleted tickets (closed → the pane offers
  create-linked-follow-up, mirroring the inbound closed-ticket behavior).

### 3.4 Time endpoints

Narrow handlers over `timeEntryService`:

- `GET /office-addin/time/running` — the technician's global running timer (the
  pane always shows it; starting a timer on another ticket warns first, because
  `startTimer` auto-stops the existing one).
- `POST /office-addin/time/start` / `POST /office-addin/time/stop` — scoped to a
  ticket.
- `POST /office-addin/time/log` — manual entry against a ticket (duration,
  description, billable flag per org defaults; AI-suggested duration is a
  prefill, §6).

No bulk approval, no timesheet, no arbitrary update/delete via the add-in token.

## 4. New table: `ticket_email_links`

The cross-channel association + idempotency ledger. Tickets keep their single
`email_message_id`/`email_thread_key` columns (correct for the created-from-email
case and never overwritten); the link table handles everything plural.

| column | notes |
|---|---|
| `id` | uuid PK |
| `ticket_id` | FK `tickets` |
| `org_id` | NOT NULL, denormalized from the ticket |
| `partner_id` | NOT NULL, denormalized |
| `message_id` | normalized Internet Message-ID |
| `comment_id` | nullable FK `ticket_comments` — the comment this link produced |
| `origin` | `addin_link` \| `addin_create` \| `inbound` (extensible: `backfill`) |
| `visibility` | `public` \| `internal` |
| `linked_by` | nullable FK `users` (null for pipeline-origin rows) |
| `created_at` | |

Constraints: **unique `(partner_id, message_id)`** — one canonical association
per message per partner; this is the idempotency claim both the add-in and the
mailbox poller take, closing the race where a technician working inside the
partner's connected ticket mailbox and the 90-second poller process the same
message concurrently.

Behavior contract:
- Add-in link/create: atomically claim the message-id; on conflict, return the
  existing association (same ticket → idempotent success; different ticket → 409).
- Inbound pipeline: consult legacy ticket columns **plus** link rows when
  matching; after accepting an inbound reply, record that reply's own Message-ID
  as a link row too (preserves the next hop when clients strip older References).
- Live/resolved/closed/deleted continuation rules are unchanged — the link-table
  lookup must not re-enable appending to closed or deleted tickets.

Tenancy/RLS: **Shape 1** (direct `org_id`, auto-discovered policy) with
`partner_id` denormalized for the uniqueness constraint. Full registration
contract: `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical, FK-child-before-parent
verified), `CORE_TENANT_EXPORT_POLICY` (every column classified; no jsonb
columns), RLS forge test. No `device_id` → no device lists.

Migration: `2026-08-<day>-<slug>.sql`, idempotent, policies in the same migration.

## 5. Shared thread-matcher extraction

The matching logic (`findTicketInPartner`, `findClosedTicketInPartner`, subject
token parsing, thread-key handling) currently lives privately inside
`services/inboundEmail/inboundEmailService.ts`. It is extracted into a shared
service (e.g. `services/inboundEmail/threadMatcher.ts`) consumed by:

- the inbound pipeline (behavior-neutral refactor, covered by existing tests),
- `POST /office-addin/email-context` and the link/create endpoints,
- (v2) the backfill converter.

This is the guard against the add-in and the pipeline drifting on
closed/resolved/deleted semantics.

## 6. AI drafting

New email-specific service (modeled on `aiTicketDraft.ts`, which is
transcript-specific and unsuitable as-is): input = email subject/body (+ thread
context when available), output = `{ subject, summary, suggestedTimeMinutes }`.

- Deterministic fallback (subject passthrough + trimmed body quote) when AI is
  unavailable, over budget, or times out — the create flow never blocks on AI.
- Everything is a prefill the technician edits; **AI never chooses the tenant,
  the customer, or the thread association.**
- Entitlement/budget: gated on the partner's existing AI entitlement; standard
  DLP treatment applies to what is sent to the model.

## 7. UI

Structured technician pane — **not** a chat variant.

- **`office-addin-core`** keeps shared auth/boot/config/API primitives. Changes:
  the session store becomes a **versioned discriminated union**
  (`{ v: 2, persona: 'tech' | 'client', ... }` under a new storage key) so a
  stale unversioned `breeze-client-ai-session` can never bypass persona
  resolution; the boot path accepts an injected persona renderer.
- **`apps/outlook-addin`** owns persona routing and the tech pane. Word/Excel/
  PowerPoint are untouched (they never inject a tech renderer). Pane layout:
  1. Context card — resolved org, contact candidates (picker when ambiguous),
     "no match" state with manual org search.
  2. Thread-matched ticket (if any) + open/recent tickets list.
  3. Actions — link to selected ticket (public/internal), create ticket
     (AI-prefilled editable form).
  4. Time widget — global running timer, start/stop on the linked ticket, manual
     log with suggested duration.
- Mutations surface outcomes with the pane's toast/inline-error pattern; the
  add-in is not under the web `runAction` contract but follows the same
  no-silent-mutation principle.

### Host-layer work (Outlook specifics)

- Reading `internetMessageId` and full headers (`getAllInternetHeadersAsync`)
  requires **Mailbox requirement set 1.8; the manifest declares 1.5**. The
  manifest minimum is NOT raised (the same deployment serves client-AI users on
  older hosts). Runtime capability detection: with 1.8+, full header-based
  matching; below, degrade to subject-token + sender matching and say so in the
  context card. References parsing handles folded/multi-value headers.
- **Pinned pane:** `ItemChanged` cancels in-flight context requests, clears
  selected ticket/form state, and rejects stale responses via an item-generation
  key (the current subscription only refreshes a label and has a no-op
  unsubscribe — that gets fixed). Temporarily-null items are handled per
  Microsoft's pinnable-taskpane guidance.
- **Compose mode:** tech actions disabled with an explanatory state (a draft's
  recipients are not a sender). The client persona keeps its existing compose
  behavior.
- **Shared mailboxes:** out of scope v1 (requires Mailbox 1.13 +
  `SupportsSharedFolders`); detected and messaged, the actor is always the
  signed-in technician.

## 8. Auto-threading honesty

Stamping threading keys only pays off when future customer replies actually reach
Breeze: via the partner's connected ticket mailbox (Graph poller) or the
partner's inbound address (Mailgun). An email linked from a technician's
*personal* mailbox will not auto-thread its future replies — nothing ingests that
mailbox. The pane states this (based on whether the partner has an inbound path
configured) and relies on manual re-link for those threads. No personal-mailbox
ingestion is built in v1.

## 9. Testing

- **Auth:** exchange matrix — no binding → client persona unchanged; bound +
  eligible → tech; bound + disabled/offboarded/epoch-advanced → deny (never
  client JIT); dual-mapped tenant (MSP registered for client-AI too) resolves by
  binding presence. Bind flow requires MFA. Middleware re-checks live state
  (deactivate user mid-session → 401).
- **RLS:** forge tests for both new tables (cross-partner 42501); registration
  suites (`rls-coverage`, `tenantCascade`, export-policy round-trip) — these need
  the real-DB integration configs, which `pnpm test` does not run.
- **Ledger:** same message → same ticket idempotent; → different ticket 409;
  add-in/poller race (concurrent claim) produces exactly one comment; inbound
  reply records its own Message-ID; closed/resolved/deleted matching preserved
  (shared-matcher tests run against both consumers).
- **Context endpoint:** selected-org and site-restricted technicians never see
  other orgs' tickets/domains; ambiguous contacts return candidates, not a pick.
- **Host layer:** capability detection at 1.5 vs 1.8; pinned-pane rapid item
  switching cancels stale responses; compose mode disabled; send-on-behalf uses
  `from` not `sender`.
- Client-tool contract tests are unaffected (no new client AI tools in v1).

## 10. v2 direction (recorded, not designed)

Historical backfill: Graph mailbox history (reusing `ticketMailbox` connection +
delta infrastructure) → AI-proposed ticket/time-entry conversions → a review
queue (quarantine-style, like `ticket_email_inbound`) where a technician approves
batches before anything is created. The v1 shared matcher and
`ticket_email_links` ledger (with an `origin = 'backfill'` value) are the
foundation; client knowledge history builds on the same corpus. AI reply drafting
for ticket threads is a separate v2 item.
