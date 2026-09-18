---
title: Partner sending domains (custom outbound email domains, hosted and self-hosted)
date: 2026-09-17
status: Approved by Todd 2026-09-17 (Gate A) as written — D1–D7 resolved per the recommendations in §12. Advisor quorum applied (Fable + Opus; Codex capped until 2026-09-19)
tracking_issue: LanternOps/breeze#6180
related:
  - docs/superpowers/specs/ticketing/2026-06-13-ticketing-phase4-email-to-ticket-design.md
  - docs/superpowers/specs/ticketing/2026-06-29-m365-exchange-mailbox-email-to-ticket-design.md
issues:
  - LanternOps/breeze#3363
  - LanternOps/breeze#4199
---

# Partner sending domains

## 0. Context

Every email a hosted Breeze instance sends leaves from one platform address,
`EMAIL_FROM` (`no-reply@2breeze.app`). The only per-partner customisation is a
display name on quotes and invoices: `"Acme MSP via Breeze" <no-reply@2breeze.app>`
(`EmailService.fromWithDisplayName`, `apps/api/src/services/email.ts:232`). A
partner with a connected M365 shared mailbox gets ticket replies from their own
domain through Graph (`services/ticketMailbox/`); nothing else does.

MSPs want their customers to see mail from the MSP, not from Breeze. This spec
lets a partner add a DNS domain, publish the DKIM/SPF records we show them, and
once the domain verifies, send customer-facing mail From an address on it.

Self-hosted instances have the mirror-image gap. The operator already sends
from their own domain by setting `EMAIL_FROM`, usually through an SMTP relay,
but gets exactly one address for everything: tickets, invoices and password
resets all come from the same mailbox. They need per-stream senders, on
whatever transport they run, without an upgrade changing anything they did not
ask for. §2.1 covers how the same design serves both.

### 0.1 Decisions already made (Todd, 2026-09-10)

Recorded in memory `email_send_domain_has_no_mx_reply_path_broken`; not
relitigated here.

1. **Verified domain on our relay.** The partner proves DNS control; Breeze
   sends through Breeze's provider account. Breeze never stores partner SMTP
   credentials.
2. **Provider-neutral interface** `EmailDomainProvider` (create / get status /
   verify / delete). Instances on SMTP or Mailgun show the feature as
   unsupported.
3. **Resend first, Amazon SES second.** Stay on Resend now. Cut hosted to SES
   when partner domains outgrow Resend's plan caps or EU-region sending is
   wanted. Order: interface → Resend adapter → ship → SES adapter.

Decision 2 was made with hosted in mind. §2.1 proposes one amendment for
self-hosted instances (the `static` adapter, D7): there the operator owns the
mail relay, so "unsupported on SMTP" would withhold per-stream senders from the
deployments that can authorise any From domain themselves.

### 0.2 Provider facts this design rests on

Verified against provider docs on 2026-09-17 unless marked otherwise.

| Fact | Consequence |
|---|---|
| Resend enforces **account-wide** limits: bounce rate < 4 %, spam rate < 0.08 %; breach pauses sending for the whole account. | Partner-domain mail must not share an account with auth mail (§2). |
| Domain management needs a `full_access` API key; `sending_access` keys can only send. | The partner lane needs its own key regardless. |
| "A domain can only be active on one Resend team at a time." Adding a domain that is verified in another team starts a *claim* flow that **releases it from the other team**. | Never call the claim API. Recommend a dedicated subdomain (§4.2). |
| `POST /domains` takes `name`, `region` (`us-east-1`, `eu-west-1`, `sa-east-1`, `ap-northeast-1`), `custom_return_path` (default `send`); returns `id` and `records[]` (`record`, `name`, `type`, `ttl`, `status`, `value`, `priority`). `POST /domains/:id/verify` is asynchronous. | Shapes the interface (§5). |
| Domain statuses: `not_started`, `pending`, `verified`, `partially_verified`, `partially_failed`, `failed` (not detected within 72 h), `temporary_failure` (was verified, DNS vanished; rechecked for 72 h, then `failed`). Resend re-checks verified domains periodically. | Status mapping (§5.2). |
| Limits: 10 req/s per team (sends and management share it). Domains: Pro 10, +100 for $20/mo, Scale 1,000. | All provider calls go through one rate-limited worker (§6). |
| Webhooks exist: `domain.updated`, `email.bounced`, `email.complained`, `email.delivered`, `email.failed`, `email.suppressed`. | Delivery feedback in W06 (§9.3). |
| SES: domain identity by Easy DKIM (3 CNAMEs), optional custom MAIL FROM subdomain, identities are per region. SES *tenants* give per-tenant reputation tracking, automatic pausing, tenant-level suppression lists, and a `TenantName` on `SendEmail`. | The interface carries a partner reference so the SES adapter can map partner → SES tenant without a schema change. |

Not verified, to be pinned by adapter contract tests in W02: the exact error
Resend returns for a send from an unverified domain and for a duplicate
`POST /domains`; whether sends keep working during `temporary_failure`; whether
a domain's region can change after creation (assumed no).

### 0.3 Repo facts this design rests on

- ~27 production send sites call `EmailService.sendEmail` or a named helper.
  Only `services/quoteLifecycle.ts:783` and `services/invoicePdf.ts:890` set
  `from` (display name) and `replyTo: partner.billingEmail`.
- Ticket mail (`jobs/ticketNotifyWorker.ts:574-596`) prefers the partner's
  Graph mailbox, else the platform sender with Reply-To
  `{slug}@TICKETS_INBOUND_DOMAIN` and Message-ID
  `<ticket-{id}@TICKETS_INBOUND_DOMAIN>` (`services/inboundEmail/outboundThreading.ts`).
- `partner_inbound_domains` (`db/schema/emailInbound.ts:31`) is the dormant
  "Model-B" seam for branded **inbound** domains on Mailgun. Empty in prod.
- No delivery-event ingestion, suppression list, or per-partner send cap exists.
- Partner-axis tables return zero rows to org-scoped and portal contexts; the
  sanctioned read is `readWithPartnerAxisVisibility` (`db/partnerAxisRead.ts`).
- A request handler that makes a slow network call pins a pooled connection for
  the whole call unless the route is in `SELF_MANAGED_DB_CONTEXT_ROUTES`
  (#1105, #1448, #6124).
- `cascadeDeletePartner` (`services/tenantCascade.ts:1591`) auto-discovers every
  table with a `partner_id` column. There is no precedent for cleaning up an
  external resource when a partner goes away.
- Trust gating: `partners.trust_state` ∈ `probation | trusted | restricted`,
  `GatedCapability` + `requireCapability()` in `services/partnerTrust.ts`.
  `partners.plan` exists but nothing gates on it.

### 0.4 Advisor quorum (2026-09-17)

Codex was unavailable (subscription usage cap until 2026-09-19), so the second
opinion came from an Opus advisor that received the facts and eleven design
questions blind, without this spec's positions. Same-vendor independence is
weaker than Fable + Codex; rerun the questions on Codex `xhigh` before W02 if
that matters.

**Agreed independently:** partner-axis only; a separate provider account for
partner-domain mail; never invoke the provider claim flow; a status machine
plus a `partner_id`-free outbox for provider cleanup; suspension stops sending
but keeps the provider domain; polling first, webhooks later; deployment
invites and all staff/auth mail stay on the platform sender; a compile-time
requirement on `sendEmail` and removal of the raw `from`.

**Adopted from the advisor:**

- A central purpose registry (§8.1) instead of call sites naming a lane. The
  classification becomes one reviewable file, platform purposes short-circuit
  before any lookup, and the purpose doubles as a delivery-event tag.
- Wave order: the sender contract lands first with zero behaviour change (§15).
- An optional sending-only key for the partner lane (§11).
- Resolve in the ambient DB context when it can already see the partner; take
  the system-context escape only when it cannot (§8.3).

**Disagreements, resolved here:**

- *Breeze-issued TXT ownership challenge before provider create.* The advisor
  wants it: unproven claims never reach the provider and never hold a name. This
  spec keeps single-step setup: DKIM publication is the industry-standard proof,
  a squatter must first be a `trusted` partner and can block a name for at most
  six days, and a second DNS round-trip (often a ticket to whoever runs the
  partner's DNS) is a real adoption cost. The challenge is additive later, as a
  state before `provisioning`. Surfaced as D6.
- *Two streams or three.* The advisor proposed `support` and `billing` only.
  This spec keeps `general` as the catch-all so future customer-facing mail
  (scorecards, agreements, lifecycle reports) has a home without being forced
  into a stream whose replies route somewhere wrong.
- *Loop prevention by sending domain.* The advisor proposed treating inbound
  mail from a partner's sending domain as our own. With a root domain that would
  drop every staff member's mail. §8.5 marks our own mail instead.
- *Resolver cache.* Declined for v1 (§8.3).

**Second round, self-hosted (same advisor, same blind format).** It agreed
independently that the self-hosted need is per-stream senders rather than a DNS
wizard, that an operator-attested mode is the right answer on SMTP and Mailgun,
that a pre-existing provider domain must be adopted and never deleted, and that
the hosted safeguards must default off. Adopted from it: a `static` domain only
becomes `verified` after the relay accepts a test send (§5.1); new env vars must
never be wired through `requireIf` on `EMAIL_PROVIDER` (§11); a send-only
provider key degrades to a clear "unavailable" state instead of failing each
request (§5.1). Not adopted: forcing an explicit Reply-To on the `support`
stream when inbound email is unconfigured. The From address is one the partner
chose as their support mailbox, which is a better reply target than today's
`EMAIL_FROM`; the UI warns instead (§4.4).

## 1. Goals and non-goals

**Goals**

- G1. A trusted partner can add a domain, see the DNS records, and have Breeze
  detect verification without contacting support.
- G2. Customer-facing mail is sent From the partner's domain with aligned
  DKIM and SPF, per mail stream, only for streams the partner configured.
- G3. A custom-domain problem never loses mail: a definitive failure on the
  partner lane falls back to the platform sender.
- G4. A partner's sending reputation cannot stop platform mail (password
  resets, verification, security notices).
- G5. Every new email added to the codebase must declare who it is from; the
  compiler refuses an unclassified send.
- G6. Provider-side domains are released when a partner removes them, is
  offboarded, or is cascade-deleted.
- G7. Self-hosted is a first-class deployment, not a by-product (§2.1):
  - per-stream sender addresses work on **any** transport a self-hoster runs
    (SMTP relay, Mailgun, Resend), not only where a domain API exists;
  - upgrading changes nothing: no new required env var, no boot refusal, and
    every email identical until the operator opts in;
  - nothing depends on hosted-only machinery (trust states, inbound webhooks,
    a dedicated provider account);
  - the feature can never damage the operator's existing mail setup, in
    particular never delete a provider domain it did not create.

**Non-goals**

- Per-organization sending domains (§3.1).
- Partner-supplied SMTP credentials or BYO provider accounts.
- Branded inbound domains (Model B). This spec composes with that seam (§3.4)
  and does not build it.
- Moving platform-class mail (auth, security, staff notices) to a custom domain.
- Marketing or bulk mail, open/click tracking, custom tracking subdomains.
- The SES adapter. The interface is designed for it; the adapter is its own
  spec when the cutover trigger fires.
- A plan/entitlement system (§12, D1).
- Exposing any of this through AI or MCP tools.
- Moving existing in-request sends (quotes, invoices) onto a queue.

## 2. Architecture: two lanes

```
                sendEmail({ …, purpose, partnerId })
                               │
                  resolveSender(purpose, partnerId)
             ┌─────────────────┴──────────────────┐
     platform purpose                       partner purpose
             │                  identity + verified domain + eligible?
             │                       │ no                  │ yes
             ▼                       ▼                     ▼
      PLATFORM LANE  ◄──────── fallback From ──────── PARTNER LANE
   EMAIL_PROVIDER / EMAIL_FROM                  EmailDomainProvider.send()
   existing account + key                       separate account + key
```

**Platform lane.** Today's `EmailService` transport, unchanged: `EMAIL_PROVIDER`,
`EMAIL_FROM`, sending-only key.

**Partner lane.** A second transport owned by the `EmailDomainProvider` adapter,
with its own credentials. On hosted it MUST be a separate provider account
(a second Resend team), so an account-level pause on the partner lane cannot
touch auth mail. `config/validate.ts` refuses to boot when `isHosted()` and
`EMAIL_DOMAINS_RESEND_API_KEY === RESEND_API_KEY`. Self-hosted may reuse one
key; the docs explain what that trades away.

**One partner-lane account per Breeze instance.** US and EU are separate
instances with separate databases. Each gets its own partner-lane account
(EU created in `eu-west-1`). This makes "a provider domain with no local row"
unambiguous and keeps EU mail in the EU. Nothing in the code reconciles by
deleting unknown provider domains; drift is reported, never auto-repaired (§6.4).

**All provider management calls happen in one worker.** Request handlers only
write intent rows (`provisioning`, `removing`, a check request). The worker
creates, verifies, polls, and deletes. No route needs
`SELF_MANAGED_DB_CONTEXT_ROUTES`, provider outages and the 10 req/s limit are
handled in one place, and every operation retries with backoff.

### 2.1 Deployment modes

| | Hosted | Self-hosted, domain API (`resend`) | Self-hosted, any relay (`static`) | Not configured |
|---|---|---|---|---|
| `EMAIL_DOMAINS_PROVIDER` | `resend` | `resend` | `static` | unset (default) |
| Who proves the domain | Partner, by DNS, via the wizard | Partner/operator, by DNS, via the wizard | Operator lists it in `EMAIL_DOMAINS_STATIC_ALLOWED`, then the relay must accept a test send | — |
| Partner-lane transport | Separate provider account (required) | Same or separate account (operator's choice) | The platform transport itself (`EMAIL_PROVIDER`) with the custom From | — |
| Trust gating | `partnerTrustMode()`; GA requires `enforce` | `off` (the function returns `off` whenever `!isHosted()`), so every partner is eligible | `off` | — |
| Caps, allowlist, auto-suspend | On | Off unless the operator sets them | Off unless set | — |
| Delivery webhooks (W06) | Required for GA | Optional; polling alone is complete | Not applicable | — |
| Behaviour after upgrade | — | Unchanged until opted in | Unchanged until opted in | Unchanged. Tab hidden, routes 404, worker not registered. |

Why self-hosted needs more than "set `EMAIL_FROM`":

- A self-hosted MSP already sends from its own domain, but from **one** address
  for everything. What it lacks is `support@` for tickets and `billing@` for
  invoices. Sender identities and the purpose registry give it that; the
  `static` adapter makes them available without a domain API.
- Most self-hosters relay through SMTP (Microsoft 365, Postfix, SES SMTP). The
  operator controls which From domains that relay may use, so there is no DNS
  for Breeze to check. The operator lists the domains; a row becomes `verified`
  when the relay accepts a test send from it, which catches the common failure
  (the relay refusing the sender) at setup instead of on a customer's invoice.
- Self-hosted instances are usually one partner, sometimes several. A `static`
  entry may be bound to a partner (`acme.com:acme-slug`); an unbound entry can
  be claimed by any partner on the instance, which is right for the
  single-partner case and documented as such.

Rules that differ by mode, each stated where it applies: the platform-domain
rejection (§4.1), adoption of a pre-existing provider domain (§5.1), the drift
report (§6.4), cap defaults (§9.1), boot validation (§11).

## 3. Data model

Three tables. Migration named to sort after the newest committed migration at
implementation time (on 2026-09-17 that is `2026-10-17-140000-*`). Idempotent,
no inner `BEGIN/COMMIT`, RLS in the same file.

### 3.1 `partner_sending_domains` — shape 3, partner-axis

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `partner_id` | uuid not null → `partners(id)` | RLS axis. No `ON DELETE CASCADE` (§3.5). |
| `domain` | varchar(253) not null | Lowercase ASCII (A-label). |
| `provider` | varchar(20) not null | `resend` \| `ses` \| `static` \| `fake`. |
| `provider_domain_id` | text null | Null while `provisioning` and after release. Always null for `static`. |
| `provider_managed` | boolean not null default true | False when the provider domain existed before Breeze asked for it (§5.1). Breeze never deletes a provider domain it does not manage. |
| `provision_attempted_at` | timestamptz null | Written and committed before the provider create call; lets a retry tell "ours from a crashed attempt" from "pre-existing". |
| `provider_region` | varchar(32) null | |
| `status` | varchar(20) not null default `provisioning` | §5.2. CHECK constraint on the value set. |
| `status_reason` | varchar(64) null | Machine code: `provider_conflict`, `provider_rejected`, `quota_exhausted`, `dns_not_detected`, `dns_removed`, `platform_suspended`, `abuse_auto`, `failed_expired`, `user_removed`. |
| `dns_records` | jsonb not null default `'[]'` | Normalised records (§5.1). Public DNS data, no secrets. |
| `check_requested_at` | timestamptz null | Set by "Check now". |
| `last_checked_at`, `next_check_at` | timestamptz | Worker cadence (§6.2). |
| `check_attempts` | integer not null default 0 | Backoff input. |
| `verified_at` | timestamptz null | First verification. Sticky. |
| `status_changed_at` | timestamptz not null | |
| `last_test_at`, `last_test_status`, `last_test_error` | | Test-send result (§7). |
| `last_send_error`, `last_send_error_at` | text, timestamptz null | The most recent `domain_unusable` refusal, shown in the UI. Written by the worker from the `sync-domain` job payload, never by the send path, which may be running in a context that cannot write this table. |
| `created_by` | uuid → `users(id)` ON DELETE SET NULL | |
| `created_at`, `updated_at` | timestamptz not null | |

Constraints and indexes:

- `UNIQUE (domain)`. One row owns a name, pending or verified. Mirrors
  `partner_inbound_domains_domain_uq` and the "one external identity, one
  partner" shape of `ticket_mailbox_tenant_ownerships`. Squatting is bounded by
  expiry (§4.3).
- `UNIQUE (id, partner_id)` so identities can carry a tenant-consistent FK.
- `INDEX (partner_id)`, `INDEX (next_check_at)`.
- RLS: enable + force + one `FOR ALL TO breeze_app` policy,
  `breeze_current_scope() = 'system' OR breeze_has_partner_access(partner_id)`
  for both `USING` and `WITH CHECK` (template:
  `2026-09-25-time-entry-source-and-suggestion-decisions.sql`).
- Register in `PARTNER_TENANT_TABLES`.

**Why partner-axis and not org-XOR-partner.** The "Partner-Wide First" rule
exists because org-first config tables needed painful partner retrofits. This
table starts at the partner, so that failure mode does not apply. The sender is
the MSP: the From domain is the MSP's identity, and an internal IT team is a
partner with one org, so the partner row covers both. A per-org domain means
"send to customer X's staff as customer X's domain", which is the internal
phishing shape, multiplies provider domain count by org count, and needs the
customer's DNS. The repo already carries one dormant, never-verified per-org
domain field (`portal_branding.custom_domain` / `domain_verified`,
`db/schema/portal.ts:21`); this spec does not add a second. The PR states this
justification, as the rule requires. If it is ever wanted, the extension is a nullable `org_id` on
`partner_sender_identities` (an org-specific identity pointing at another
verified domain), not a change to this table.

### 3.2 `partner_sender_identities` — shape 3, partner-axis

One row per (partner, stream). A stream with no row sends from the platform
sender. There is no implicit fallback between streams: what the partner
configures is exactly what changes.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `partner_id` | uuid not null → `partners(id)` | RLS axis. |
| `sending_domain_id` | uuid not null | Composite FK `(sending_domain_id, partner_id) → partner_sending_domains(id, partner_id) ON DELETE CASCADE`. |
| `stream` | varchar(20) not null | `support` \| `billing` \| `general`. CHECK. |
| `local_part` | varchar(64) not null | §4.4. |
| `display_name` | varchar(78) null | Null → partner name. |
| `reply_to` | varchar(320) null | Default Reply-To when the call site sets none. |
| `updated_by` | uuid → `users(id)` ON DELETE SET NULL | |
| `created_at`, `updated_at` | | |

`UNIQUE (partner_id, stream)`. Same RLS policy shape; register in
`PARTNER_TENANT_TABLES`. A rebrand is: verify the new domain, re-point the
identities, remove the old domain.

Streams in v1:

| Stream | Mail | Suggested local part |
|---|---|---|
| `support` | Ticket notifications to customers, portal invites, portal password resets | `support` |
| `billing` | Quotes, invoices | `billing` |
| `general` | Scheduled report deliveries | `notifications` |

### 3.3 `email_provider_domain_releases` — system outbox

Holds "delete this provider domain" work that must survive the partner's rows
being deleted. It MUST NOT have a `partner_id` column: `cascadeDeletePartner`
deletes from every table that has one, which would erase the provider handle
this table exists to keep.

Columns: `id`, `provider`, `provider_domain_id`, `provider_region`, `domain`,
`reason`, `requested_at`, `attempts`, `next_attempt_at`, `last_error`.
`UNIQUE (provider, provider_domain_id)`. Forced RLS, single system-only policy.
Register in `INTENTIONAL_UNSCOPED` (precedents: `intent_outbox`,
`oauth_revocation_retries`). Rows are deleted on success; a row stuck past 10
attempts raises an ops alert (`services/opsAlerts.ts`).

### 3.4 Composition with `partner_inbound_domains`

Separate tables. Inbound and outbound use different providers (Mailgun vs
Resend/SES), different records (MX on the domain vs DKIM + return-path), and
different lifecycles. The same domain may legitimately do both:
`support.acme.com` with MX → Mailgun and DKIM → Resend gives From = Reply-To =
`help@support.acme.com`, the fully white-labelled loop. To keep that coherent:

- The sending-domain service rejects a domain that exists in
  `partner_inbound_domains` under a **different** partner. The Model-B wizard
  must make the mirror check when it is built. Recorded here so it is not lost.
- Column names follow the inbound table where they mean the same thing
  (`provider`, `provider_domain_id`, `dns_records`, `verified_at`).

### 3.5 Registration and lifecycle contracts

- Neither partner-axis table has `org_id` or `device_id`: no entry in
  `CORE_ORG_CASCADE_DELETE_ORDER`, the device lists, the export policy, or the
  org-merge registry. `cascadeDeletePartner` discovers both by `partner_id`.
- **Provider release guard.** A `BEFORE DELETE` trigger on
  `partner_sending_domains` raises when `OLD.provider_domain_id IS NOT NULL`.
  A row may only be deleted after the service has either confirmed provider
  deletion or written the outbox row, and nulled `provider_domain_id` in the
  same transaction. A delete path that forgets this fails loudly instead of
  leaking a provider domain. (The org-merge trigger-classification contract
  covers `BEFORE UPDATE` triggers on `org_id` tables; it does not apply.)
- `releaseSendingDomainsForPartner(partnerId)` (system context) nulls
  `provider_domain_id` for every domain of the partner, writing an outbox row
  first for each one that is `provider_managed`. Called
  first thing in `cascadeDeletePartner` and in `finalizePartnerOffboarding`
  (`services/tenantOffboarding.ts`).
- Any migration statement that writes rows elects system scope first
  (`migrationRlsScope.test.ts`). This migration creates tables only.

## 4. Domain rules

### 4.1 Normalisation and validation

One shared validator, `normalizeSendingDomain`, in
`packages/shared/src/validators/` (used by API and web): trim, lowercase, strip
a trailing dot, convert IDN to A-label (WHATWG `URL` hostname parsing, which
behaves the same in Node and the browser), then reject: scheme,
path, port, `@`, wildcard, IP literal, fewer than two labels, any label outside
1–63 LDH characters, total length over 253, an all-numeric TLD.

The API additionally rejects:

- **hosted only** — platform-owned domains: the domains of `EMAIL_FROM`,
  `TICKETS_INBOUND_DOMAIN`, `PUBLIC_APP_URL`, and a static list (`2breeze.app`,
  `breezermm.com`, `lanternops.io`), including their subdomains. On a
  self-hosted instance the `EMAIL_FROM` domain *is* the MSP's domain and is
  exactly what the operator will add, so this rule must not run there;
- consumer mail domains (`isConsumerEmailDomain`, `services/consumerEmailDomains.ts`);
- public suffixes (add `tldts`; no PSL library is in the repo today);
- anything in the operator's `EMAIL_DOMAINS_DENYLIST`.

### 4.2 Root or subdomain

Both are allowed. The UI recommends a dedicated subdomain (`mail.acme.com`) and
says why:

- reputation isolation (Resend's own recommendation);
- a root domain that the partner already uses with Resend elsewhere cannot be
  added here without the claim flow, which we never invoke;
- mail from `x@acme.com` relayed externally to recipients at `acme.com` trips
  "external sender using our domain" rules in some mail filters even when DKIM
  passes. A subdomain avoids the exact-match heuristic. This matters for
  internal IT teams, whose customers are their colleagues.

Provider records never collide with the partner's existing mail: DKIM lives at
`resend._domainkey.<domain>`, SPF and MX at the return-path label
`send.<domain>`.

### 4.3 Ownership, uniqueness, squatting

Provider DKIM verification is the ownership proof: the records are generated
per provider domain object, and one provider domain object belongs to exactly
one row (`UNIQUE (domain)` plus the one-account-per-instance rule). A partner
who cannot publish DNS can never reach `verified`.

A partner who adds a domain they do not own can only *block* it, and only
briefly: the provider fails unverified domains after 72 h, and the worker
auto-removes `failed` rows 72 h after that (the window in which "Retry" keeps
the same DNS records). Creates are rate-limited (5/day/partner), repeated
failed verifications emit an abuse signal (§9.2), and a platform admin can
force-release a row.

Both "held by another partner" and "exists at the provider outside Breeze"
return the same `409 domain_unavailable` with one message: the domain may
already be registered with Breeze or our email provider; use a dedicated
subdomain or contact support. No information about who holds it.

A Breeze-issued TXT challenge (the `ssoDomainVerification` pattern) that lets
a proven owner evict a pending squatter is a possible later addition. It is
not needed for correctness and adds a DNS record to every setup.

### 4.4 Sender identity rules

- `local_part`: `^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$`, no consecutive
  dots; `postmaster`, `abuse`, `mailer-daemon` refused.
- `display_name`: passes the existing header-safety strip
  (`fromWithDisplayName`), max 78 chars, must not contain `@` or `://` (the
  "display name that looks like another address" spoof).
- The From address is always `local_part@<the verified row's exact domain>`.
  The partner never types a full From address.
- The UI states next to each stream where replies go (§8.3). Mail clients
  honour Reply-To, but people and auto-responders sometimes answer the From
  address, so each local part should be a real mailbox or alias. For `support`
  the recommended setup is an alias that forwards to the partner's Breeze
  inbound address, so a reply to From still reaches the ticket.

## 5. Provider interface

`apps/api/src/services/emailDomains/provider.ts`

```ts
export type SendingDomainStatus =
  | 'provisioning' | 'pending' | 'verified' | 'at_risk'
  | 'failed' | 'suspended' | 'removing';

export interface ProviderDnsRecord {
  purpose: 'dkim' | 'spf' | 'return_path_mx' | 'other';
  type: 'TXT' | 'CNAME' | 'MX';
  host: string;        // as the provider returns it (relative label)
  fqdn: string;        // computed: what must resolve
  value: string;
  priority?: number;
  ttl?: string;
  status: 'pending' | 'verified' | 'failed';
}

export interface ProviderDomain {
  providerDomainId: string | null;   // null for `static`
  region?: string;
  createdAt?: Date;                  // provider-side creation time, when known
  state: 'pending' | 'verified' | 'at_risk' | 'failed';
  records: ProviderDnsRecord[];      // empty for `static`
}

export type PartnerLaneSendError =
  | { kind: 'domain_unusable' }     // provider says the domain cannot send
  | { kind: 'lane_unavailable' }    // 429, account paused, quota
  | { kind: 'message_rejected'; detail: string }  // bad recipient, too large
  | { kind: 'ambiguous'; detail: string };        // timeout, 5xx, network

export interface EmailDomainProvider {
  readonly id: 'resend' | 'ses' | 'static' | 'fake';
  readonly verifiesByDns: boolean;   // false for `static`: no wizard, no polling
  createDomain(i: { domain: string; region?: string; partnerRef: string }): Promise<ProviderDomain>;
  findDomainByName(domain: string): Promise<ProviderDomain | null>;
  getDomain(providerDomainId: string): Promise<ProviderDomain>;
  requestVerification(providerDomainId: string): Promise<void>;
  deleteDomain(providerDomainId: string): Promise<void>;   // 404 is success
  listDomains(): Promise<Array<{ providerDomainId: string; domain: string }>>; // drift report only
  send(m: PartnerLaneMessage & { partnerRef: string; tags: Record<string, string> }):
    Promise<{ providerMessageId: string }>;                // throws PartnerLaneSendError
}
```

`partnerRef` is the partner id. Resend ignores it on `createDomain` and sends
it as a message tag; SES will map it to a tenant named `bz-<partnerId>`.
`tags` always carries `partner_id`, `domain_id`, `stream` and `purpose` so
delivery webhooks can attribute events (§9.3).

### 5.1 Adapters

- **`resend`** — second `Resend` client on `EMAIL_DOMAINS_RESEND_API_KEY`
  (on self-hosted this may be the operator's one Resend account). Creates with
  `region = EMAIL_DOMAINS_REGION`, default return path. Provisioning is
  find-then-create, and classifies what it finds:
  1. Commit `provision_attempted_at = now()`.
  2. `findDomainByName`. Nothing found → `createDomain` → `provider_managed = true`.
  3. Found, and its provider `createdAt` is later than `provision_attempted_at`
     → ours, from an attempt that crashed before the local update → adopt,
     `provider_managed = true`.
  4. Found, and older → it pre-existed → adopt with `provider_managed = false`.
     If it is already verified, the row is `verified` at once.
  Case 4 is the normal self-hosted path: the operator adds `acme.com`, which is
  already the verified `EMAIL_FROM` domain in their account. **A row with
  `provider_managed = false` is never deleted at the provider**; removing it
  only drops the local row. Deleting it would take down the operator's primary
  sending domain. An ambiguous case resolves to "not managed": leaking one
  provider domain is recoverable, deleting someone's mail domain is not.
  The adapter never falls back to `RESEND_API_KEY`: self-hosters' existing key
  is almost always `sending_access`. On worker start it probes once with
  `listDomains`; a permission error sets the capability to
  `supported: false, reason: 'provider_key_send_only'`, which the settings tab
  explains, rather than failing every add-domain request.
- **`static`** — self-hosted only; refused by `config/validate.ts` when
  `isHosted()`. No external calls. `createDomain` returns `pending` with no
  records when the domain is in `EMAIL_DOMAINS_STATIC_ALLOWED` and, if the
  entry is bound (`domain:partner-slug`), the partner matches; otherwise it
  fails with `provider_rejected` and the UI tells the user to ask the instance
  administrator. **The row becomes `verified` when a test send is accepted by
  the relay** (§6.1); a refusal leaves it `pending` with the relay's error shown
  verbatim. `send` hands the message to the platform transport with the custom
  From. A relay refusal of the sender (SMTP `550 5.7.60`, `553`, a
  Mailgun or Resend "domain not verified") maps to `domain_unusable`, so the
  message falls back to `EMAIL_FROM` instead of being lost. `deleteDomain` is a
  no-op. Breeze cannot check that the relay signs for the domain: the docs say
  plainly that listing a domain does not authorise it, and that DKIM/SPF for it
  are the operator's mail setup.
- **`fake`** — deterministic, for unit, integration, E2E and wt-stack.
  `*.verify.test` verifies on the first check, `*.fail.test` fails,
  `conflict.test` raises the conflict. `send` hands the message to the platform
  transport verbatim so a local Mailpit shows the custom From. Refused in
  production by `config/validate.ts`, same as the workspace `fake` backend.
- **none** — `EMAIL_DOMAINS_PROVIDER` unset. Capability is false, routes
  return `404 sending_domains_unsupported`, the settings tab is hidden.

### 5.2 Status model

| Status | Meaning | Sends on partner lane |
|---|---|---|
| `provisioning` | Row written; provider object not created yet. | no |
| `pending` | Provider object exists; waiting for DNS. For `static`: listed by the operator; waiting for an accepted test send. | no |
| `verified` | Provider confirms the sending records. | yes |
| `at_risk` | Was verified; provider reports DNS missing (72 h grace). | yes, with fallback |
| `failed` | Provider gave up, or provisioning was refused. `status_reason` says which. | no |
| `suspended` | Platform kill switch (admin or automatic). Partner cannot undo it. | no |
| `removing` | Removal requested; worker deletes at the provider, then the row. | no |

Resend mapping, keyed on whether *sending* is usable: `not_started`/`pending` →
`pending`; `verified`/`partially_verified` → `verified`; `temporary_failure` →
`at_risk`; `failed` → `failed`; `partially_failed` → `at_risk`. An unknown
provider status maps to `pending` and logs a warning, so the unknown case never
sends.

## 6. Worker

Queue `sending-domains`, registered in `services/workerRegistry.ts` /
`jobs/workerReadinessManifest.ts`, enabled only when a provider is configured.
System DB context. BullMQ limiter at 5 req/s so management calls leave headroom
under the account's 10 req/s for sends.

### 6.1 Jobs

- **`sync-domain { domainId }`** (`jobId = domainId`, so duplicates collapse).
  Advances one row one step, idempotently:
  - `provisioning` → find-then-create (§5.1) → store id, region, records,
    `provider_managed` → `pending` (or `verified` when adopted already
    verified) → `requestVerification` when still pending and the adapter
    verifies by DNS. A `static` row waits in `pending` for its test send.
    Provider conflict or rejection → `failed` with reason.
  - `pending` / `verified` / `at_risk` → `getDomain` → map → update. A
    `check_requested_at` newer than `last_checked_at` calls
    `requestVerification` first. Adapters with `verifiesByDns = false` never
    call `requestVerification`; for `static`, `getDomain` is a local lookup
    against `EMAIL_DOMAINS_STATIC_ALLOWED`, re-run on worker start and daily,
    so a domain the operator delists stops being used.
  - `failed` for more than 72 h → `removing` (`failed_expired`).
  - `removing` → `deleteDomain` **only when `provider_managed`** → null
    `provider_domain_id` → delete the row (identities cascade).
  - `suspended` → no provider calls.

  The release path in §3.5 follows the same rule: an outbox row is written only
  for a managed provider domain.
- **`sweep`** (repeatable, 60 s): selects due rows
  (`next_check_at <= now()`, `LIMIT 25`, `FOR UPDATE SKIP LOCKED`), enqueues
  `sync-domain` for each, and drains due outbox rows.
- **`test-send { domainId, userId }`** (§7). Calls the adapter's `send`
  directly, bypassing `resolveSender`, so a domain can be tested before any
  identity exists: From `<support identity local part, else "test">@<domain>`,
  To the requesting user's own address, tagged `purpose=sending_domain.test`.
  It requires the partner to hold the capability and the row to be `verified`
  or `at_risk`, or, for `static` only, `pending`: there an accepted test send
  is the verification step and moves the row to `verified`. It counts against
  the daily cap. The outcome is written to `last_test_*`.

Routes enqueue `sync-domain` after commit so the UI sees DNS records within
seconds instead of waiting for the sweep.

### 6.2 Cadence

`pending`: 2 min × 5, then 10 min × 6, then hourly until the provider fails it.
`at_risk`: hourly. `verified`: every 24 h ± 10 % jitter, per row (the
`m365Sync/cadence.ts` idea). Row-level `next_check_at` spreads the load; there
is no epoch-aligned daily job to stampede at 00:00 UTC.

### 6.3 Transitions

Every status change writes an audit entry and emails the user who added the
domain plus the partner's admins: verified, at risk, failed, suspended,
auto-removed. These are a platform purpose (`staff.sending_domain_status`): a
notice that the partner's domain is broken must not be sent from it.

### 6.4 Drift report

Hosted only (`isHosted()`), where the partner-lane account is dedicated to the
instance. Daily, `listDomains()` is compared with local rows and outbox rows. A
provider domain with neither, older than 24 h, raises an ops alert. Nothing is
deleted automatically. On self-hosted the account is the operator's own and
holds domains Breeze knows nothing about, so the report would only be noise.

## 7. API

`apps/api/src/routes/partnerSendingDomains.ts`, mounted at
`/partner/sending-domains`.

Reads: `requireScope('partner')`, `requirePartner`. Writes add
`requireOrgWrite`, `requireMfa()`, and `requireCapability('custom_sending_domain')`,
the same stack as `PATCH /partners/me` (`routes/orgs.ts:906`). Every write calls
`writeRouteAudit`. No route calls the provider.

| Route | Effect |
|---|---|
| `GET /` | `{ capability: { supported, provider, eligible, reason?, maxDomains }, domains[], identities[] }` |
| `POST /` `{ domain }` | Validates (§4.1), enforces the per-partner cap and the daily create limit, inserts `provisioning`. 201. |
| `POST /:id/check` | Sets `check_requested_at`, `next_check_at = now()`. 202. Limit 1/min/domain. A `failed` row inside the retry window goes back to `pending`, or to `provisioning` when it has no provider object. |
| `DELETE /:id` | `status = 'removing'`. 202. |
| `PUT /identities/:stream` | Upsert. The domain must be the caller's and `verified` or `at_risk`. |
| `DELETE /identities/:stream` | The stream returns to the platform sender. |
| `POST /:id/test` | Enqueues `test-send`. The recipient is always the calling user's own verified address. Limit 5/h/partner. 202; the result lands on the row. |

Platform admin (`routes/admin/sendingDomains.ts`, `platformAdminMiddleware` +
`requireMfa()`, mirroring `routes/admin/trust.ts`): list across partners;
`POST /:id/suspend`, `/unsuspend`, `/force-release`.

Shared Zod schemas live in `packages/shared/src/validators/sendingDomains.ts`.

## 8. Send path

### 8.1 The `purpose` contract

`SendEmailParams.from` is removed from the public type, and
`fromWithDisplayName` becomes private to the resolver. Every send declares
*what the email is*; one registry decides who it is from.

```ts
// apps/api/src/services/emailDomains/mailPurposes.ts
export type PartnerMailStream = 'support' | 'billing' | 'general';
type MailPurposePolicy =
  | { lane: 'platform' }
  | { lane: 'partner'; stream: PartnerMailStream;
      // The From used when no partner identity applies. Preserves what each
      // send site does TODAY; see "fallback From" below.
      fallbackFrom: 'default' | 'partner_display_name' };

export const MAIL_PURPOSES = {
  'auth.password_reset':          { lane: 'platform' },
  'ticket.customer_notification': { lane: 'partner', stream: 'support', fallbackFrom: 'default' },
  'quote.sent':                   { lane: 'partner', stream: 'billing', fallbackFrom: 'partner_display_name' },
  // … one entry per row of §8.2
} as const satisfies Record<string, MailPurposePolicy>;

export type MailPurpose = keyof typeof MAIL_PURPOSES;
```

`sendEmail` requires `purpose: MailPurpose`. For a partner-lane purpose the
type also requires `partnerId: string | null` (conditional on the registry
entry); `null` resolves to the platform sender, for call sites that cannot
always resolve a partner. An unclassified send does not compile, which is the
guard for G5. Named helpers (`sendPasswordReset`, `sendPortalInvite`, …) take
the purpose where two audiences share them and hard-code it otherwise.

Three properties follow from the registry and are unit-tested over every key:

- a `platform` purpose returns before any database read and can never produce
  a partner-lane result, whatever `partnerId` the caller passes;
- every purpose is referenced by at least one send site (no dead entries);
- the purpose is attached to partner-lane messages as a provider tag, so
  delivery events can be broken down by it (§9.3).

`partnerId` must come from a row the call site already read under its own RLS
context, or from the verified auth context. Never from request input.

### 8.2 Classification of today's send sites (normative)

| Send site | Purpose | Lane / stream |
|---|---|---|
| `jobs/authEmailWorker.ts` | `auth.password_reset`, `auth.email_verification`, `auth.signup_existing_account` | platform |
| `routes/users.ts` | `auth.staff_invite`, `auth.email_change_verify`, `auth.email_changed` | platform |
| `routes/auth/login.ts`; `routes/auth/verifyEmail.ts` | `auth.account_locked`; `auth.email_verification` | platform |
| `jobs/mfaEnrollmentNotice.ts`; `routes/auth/accountDeletion.ts` ×2; `services/tenantOffboarding.ts` | `security.mfa_enrollment`; `account.deletion_requested`, `account.deletion_declined`; `account.purge_warning` | platform |
| `services/opsAlerts.ts`; `jobs/aiBudgetAlertDelivery.ts`; `services/contractRenewal.ts`; `services/quoteOutcomeNotify.ts`; `services/notificationSenders/emailSender.ts`; `services/aiToolsGoogle.ts` | `ops.alert`; `staff.ai_budget_alert`; `staff.contract_renewal`; `staff.quote_outcome`; `staff.alert_notification`; `staff.workspace_drift_report` | platform |
| `services/reportDelivery.ts` `emailReportFailure` | `staff.report_failure` | platform |
| `modules/mcpInvites/tools/sendDeploymentInvites.ts` | `deployment.invite` | platform (see below) |
| `jobs/ticketNotifyWorker.ts` → staff technician | `ticket.staff_notification` | platform |
| `jobs/ticketNotifyWorker.ts` → requester, contact, customer CC | `ticket.customer_notification` | partner / `support` |
| `routes/orgPortalUsers.ts`; `routes/portal/auth.ts` | `portal.invite`; `portal.password_reset` | partner / `support` |
| `services/quoteLifecycle.ts`; `services/invoicePdf.ts` | `quote.sent`; `invoice.sent` | partner / `billing` |
| `services/reportDelivery.ts` `emailReportRun` | `report.delivery` | partner / `general` |

`services/quoteOutcomeNotify.ts` and `services/contractRenewal.ts` go to MSP
staff, not customers, which is why they are platform purposes.

Rules behind the table:

- **Mail from Breeze to the partner's own staff stays on the platform sender.**
  Account recovery must not depend on the partner's DNS, and staff mailboxes
  are usually on the very domain being sent from (§4.2).
- **Agent-deployment invites stay on the platform sender.** They carry
  installer links to arbitrary typed addresses, which is the exact shape hosted
  abuse takes. The recipient should see Breeze's name and abuse contact.
- Ticket mail keeps its precedence: connected Graph mailbox, then partner lane,
  then platform.

### 8.3 Resolution

`resolveSender` in `services/emailDomains/senderResolution.ts` returns the
platform lane immediately for a platform purpose, a null `partnerId`, or an
unconfigured partner lane. Otherwise it makes one read joining `partners`,
`partner_sender_identities` and `partner_sending_domains`:

- in the ambient DB context when that context can already see the partner
  (system scope, or partner scope whose accessible partner ids include it);
- through `readWithPartnerAxisVisibility` otherwise (org scope, portal, no
  context). That escape holds a second pooled connection for one indexed read.
  It is reached from three human-rate HTTP send sites (quote, invoice, portal
  invite); the workers and the portal reset route already run in system scope.

It returns the partner lane only when all hold:

1. the partner lane is configured, and the partner is in
   `EMAIL_DOMAINS_PARTNER_ALLOWLIST` when that is set;
2. `partners.status = 'active'` and the partner passes
   `evaluateCapabilityContinuationForState('custom_sending_domain', …)` — the
   side-effect-free evaluator, so a send never writes a denial audit row;
3. an identity exists for the stream and its domain is `verified` or `at_risk`;
4. the partner is under the daily partner-lane cap (§9.1).

Otherwise it returns the platform lane with the purpose's **fallback From**,
which is whatever that send site produces today:

- `partner_display_name` — `"<Partner> via Breeze" <EMAIL_FROM address>`. Only
  `quote.sent` and `invoice.sent`, the two sites that do this now.
- `default` — the bare `EMAIL_FROM`. Everything else, including ticket mail,
  portal mail and reports.

This is what makes W01 byte-identical, and it matters most on self-hosted: an
operator whose `EMAIL_FROM` is already `"Acme Support" <support@acme.com>`
must not see ticket mail relabelled "Acme MSP via Breeze" by an upgrade.
Extending the display-name form to more purposes on hosted is a separate
product change, not part of this feature.

No cache in v1. Sends are low-rate, the read is one indexed query, and a cache
must be invalidated from three unrelated write paths (domain status, trust
state, partner status) to keep the kill switch immediate. When #2822 delivers
a read-only partner-axis RLS branch, this read drops the system-context escape.

Reply-To precedence: the call site's `replyTo`, then `identity.reply_to`, then
none. Tickets keep `{slug}@TICKETS_INBOUND_DOMAIN`; quotes and invoices keep
`partner.billingEmail`.

### 8.4 Failure semantics

- `domain_unusable` or `lane_unavailable` → the message was definitively not
  sent. Send it on the platform lane with the purpose's fallback From, log the
  reason, and enqueue an immediate `sync-domain` for that domain, carrying the
  refusal text for `last_send_error`.
- `message_rejected` or `ambiguous` → throw, as today. An ambiguous failure is
  never retried on the other lane, so a recipient cannot receive two copies.

### 8.5 Threading and loop prevention

- Message-ID, In-Reply-To and References keep `TICKETS_INBOUND_DOMAIN`
  whatever the From domain is. Thread matching is untouched.
- `services/inboundEmail/loopPrevention.ts` recognises our own mail partly by
  system local parts (`no-reply`) and by sender domain ==
  `TICKETS_INBOUND_DOMAIN`. A custom From has neither, so a notification that
  comes back (a contact address that forwards to the partner's support
  mailbox, which forwards into Breeze) would open or update a ticket. Mark our
  own mail instead of guessing from the sender:
  - every partner-lane message carries `X-Breeze-Outbound: 1`;
  - inbound mail is ignored when it carries that header, or when its own
    Message-ID matches the `outboundThreading.ts` generator pattern on
    `TICKETS_INBOUND_DOMAIN`.
  Forging the header only gets the forger's own mail ignored.
- Inbound mail is **not** suppressed by sending domain or identity address.
  With a root domain, every technician's address is on the sending domain, and
  a technician may legitimately write from the shared mailbox.
- Customer auto-replies are unaffected: they are dropped on `Auto-Submitted`
  today regardless of our From.
- A self-hosted instance may run without inbound email
  (`TICKETS_INBOUND_DOMAIN` unset). Then there is no inbound path to loop
  through, the rules above are inert, and partner-lane ticket mail simply has
  no Reply-To override: replies go to the From address, so the UI warning in
  §4.4 (the local part must be a monitored mailbox) is the safeguard.

## 9. Abuse and deliverability controls

### 9.1 Ships with the feature (W02–W04), before any hosted partner is enabled

- **Eligibility**: new `GatedCapability` `'custom_sending_domain'`. It takes
  the `default` branch in `partnerTrust.decide`: denied for `probation` and
  `restricted`, allowed for `trusted`, and governed by `partnerTrustMode()`
  like the other capabilities. Enforced on writes (middleware) and at send
  time (§8.3). `partnerTrustMode()` returns `off` whenever `!isHosted()`
  (`config/partnerTrustMode.ts:12`) and self-hosted partners are created
  `trusted`, so on self-hosted the gate is always open with no configuration.
  Hosted general availability requires `PARTNER_TRUST_MODE=enforce`; in
  `shadow` the gate only logs.
- **Dark launch**: `EMAIL_DOMAINS_PARTNER_ALLOWLIST`. Empty means every
  eligible partner; set means only those partner ids.
- **Kill switch**: platform-admin suspend / unsuspend / force-release.
  Suspension takes effect on the next send because resolution reads the row.
- **Caps**: `EMAIL_DOMAINS_MAX_PER_PARTNER` (default 3 rows),
  `EMAIL_DOMAINS_DAILY_SEND_CAP` (partner-lane messages per partner per UTC
  day; Redis counter). Over the cap the message goes out on the platform lane,
  as it would today, and an abuse signal fires. The send cap defaults to 2,000
  when `isHosted()` and to **unlimited** otherwise: a self-hoster's volume is
  their own business, and a default that silently moved their ticket mail back
  to the old From at message 2,001 would be a bug report, not a protection.
- **Domain hygiene**: §4.1 rejections.
- **Audit**: every mutation and every status transition.

### 9.2 Abuse signals (W06)

A `ComputedSignal` producer under `services/abuseSignals/`, wired into
`runAbuseSweep`: sending domain added (with the domain name, for human review
of lookalikes), repeated failed verifications, daily cap hit, bounce or
complaint threshold crossed. The partner trust evidence card lists the
partner's sending domains.

### 9.3 Delivery feedback (W06) — required before general availability

- `POST /webhooks/email-provider/resend`, signature-verified (svix scheme),
  registered as a public route with its DB work in system context. Handles
  `email.bounced`, `email.complained`, `email.delivered`, `email.failed`,
  `email.suppressed`, and `domain.updated` (which just enqueues `sync-domain`).
- `partner_sending_daily_stats (partner_id, day, sent, delivered, bounced,
  complained)`, partner-axis, attributed by the `partner_id` tag.
- **Automatic suspension**: a partner whose 7-day bounce rate exceeds 8 % over
  at least 50 messages, or who draws 3 complaints in 7 days, has every domain
  set to `suspended` / `abuse_auto`, with an ops alert. Thresholds are env
  vars. They sit well inside the provider's account-wide limits because many
  partners share the account.
- The admin list shows 7-day volume, bounce and complaint rates.

Until W06 is live, hosted runs with the allowlist set.

W06 is a gate for **hosted** general availability, not a functional dependency.
Many self-hosted instances sit behind NAT or a VPN and cannot receive provider
webhooks; polling (§6) is complete without them. On self-hosted the webhook
endpoint is inert unless `EMAIL_DOMAINS_WEBHOOK_SECRET` is set, automatic
suspension is off unless its thresholds are set, and the stats table simply
stays empty. `static` mode has no provider events at all.

## 10. Web UI

`apps/web/src/components/settings/PartnerSendingDomainTab.tsx`, a new tab in
the **communications** group of `PartnerSettingsPage.tsx`, beside the ticketing
tab that holds `InboundEmailCard`. Tab state in `window.location.hash`.

| State | What the partner sees |
|---|---|
| unsupported | Tab hidden. |
| `static` mode | No DNS table, no "Check now". Add-domain form, then "Send a test email to verify": the relay's acceptance verifies the domain, its refusal is shown verbatim. Then the identities form. Note: "Sending domains on this server are managed by its mail configuration; SPF and DKIM for them are set up outside Breeze." A domain the operator has not listed fails with "Ask your Breeze administrator to allow this domain." |
| not eligible | Locked card: why (probation, restricted) and a link to the trust page. |
| empty | Add-domain form, the subdomain recommendation and its reasons. |
| `provisioning` | "Preparing DNS records…", polls every 2 s. |
| `pending` | Records table (Type, Host, FQDN, Value, Priority, per-record status), copy buttons, "Check now", auto-refresh every 15 s, and a note that DNS can take up to 72 h. |
| `verified` | Stream identities form, where-replies-go text per stream, test send. |
| `at_risk` | Amber banner naming the missing record; mail still flows. |
| `failed` | Reason, Retry (inside the window), Remove. |
| `suspended` | Contact support. No actions. |
| `removing` | Disabled row. |

All mutations go through `runAction`. New i18n keys get real translations in
every shipped locale. Every interactive element has a `data-testid`.

## 11. Configuration

| Env var | Default | Notes |
|---|---|---|
| `EMAIL_DOMAINS_PROVIDER` | unset | `resend` \| `static` \| `fake`. `fake` refused in production; `static` refused when `isHosted()`. |
| `EMAIL_DOMAINS_STATIC_ALLOWED` | empty | `static` only. Comma-separated `domain` or `domain:partner-slug`. The operator's statement that the instance's mail relay may send as these domains. |
| `EMAIL_DOMAINS_RESEND_API_KEY` | — | `full_access` key of the partner-lane account, used by the domain worker. Required when the provider is `resend`. Must differ from `RESEND_API_KEY` when `isHosted()`. |
| `EMAIL_DOMAINS_RESEND_SENDING_KEY` | falls back to the key above | Optional `sending_access` key of the same account for partner-lane sends, so the send path never holds the management key. |
| `EMAIL_DOMAINS_REGION` | `us-east-1` | EU instance: `eu-west-1`. |
| `EMAIL_DOMAINS_MAX_PER_PARTNER` | `3` | |
| `EMAIL_DOMAINS_DAILY_SEND_CAP` | `2000` hosted, unlimited self-hosted | `0` = unlimited. |
| `EMAIL_DOMAINS_PARTNER_ALLOWLIST` | empty | Comma-separated partner ids. |
| `EMAIL_DOMAINS_DENYLIST` | empty | Extra refused domains. |
| `EMAIL_DOMAINS_WEBHOOK_SECRET` | — | W06. Unset = webhook endpoint inert. |

**Every variable is optional, and none is ever required by an upgrade.** With
all of them unset a self-hosted instance boots and behaves exactly as before.
Validation only ever fails on a contradiction the operator introduced
(`resend` without a key, `fake` in production) or on a hosted-only rule
(`static` on hosted, identical keys on hosted). A self-hosted `resend` setup
may use one key for both lanes; validation logs one informational line noting
that partner-domain mail then shares the account's reputation.

Two implementation rules keep that promise. In `config/validate.ts`, the new
variables are plain optional strings, and any `requireIf` is keyed on
`EMAIL_DOMAINS_PROVIDER` only, never on `EMAIL_PROVIDER`: a
`requireIf(EMAIL_PROVIDER === 'resend', …)` (the existing pattern at
`validate.ts:1681-1712`) would refuse boot on every Resend self-host that
upgrades. And the worker registers only when the provider is set, the same
enable check as `initializeAbuseSignalsWorker` (`jobs/abuseSignalsSweep.ts:149`).

Declared in `apps/api/src/config/env.ts`, validated in `config/validate.ts`,
documented in `.env.example` and `deploy/.env.example`, and mapped in the
`&api-env` anchor of `deploy/docker-compose.prod.yml` (api and worker). On the
droplets the same mapping must be added to `/opt/breeze/docker-compose.yml`; a
value in `.env` alone is inert. Self-hosters on the repo's compose file get the
mapping with the upgrade; those on a customised compose file need the same
lines, which the release notes call out.

The partner-lane key can read every message sent through that account. It
lives only in env, is never logged, and the account carries partner-lane mail
only.

## 12. Decisions (resolved 2026-09-17)

Todd approved the spec as written on 2026-09-17; each recommendation below is
the decision. The alternatives are kept for the record.

- **D1 — Plan gating.** Recommend **none in v1**: trusted partners on any plan.
  Nothing in the repo gates on `partners.plan`, an entitlement system is its
  own feature, and a domain costs about $0.20/month at Resend's add-on rate.
  If white-label should be a paid lever, that is one more clause in the
  eligibility check later.
- **D2 — Partner-lane accounts.** Recommend **one Resend team per region**
  (two × Pro, $40/month) per §2. One shared team halves the cost, loses EU
  residency, and makes the drift report ambiguous.
- **D3 — Deployment invites stay on the platform sender.** Recommend yes (§8.2).
- **D4 — Root domains allowed, subdomain recommended.** Recommend yes (§4.2).
  The stricter option is subdomain-only.
- **D5 — Alert and other staff mail stays on the platform sender in v1.**
  Recommend yes. A later `staff` stream is additive.
- **D6 — Ownership proof.** Recommend **single-step setup**: the provider's
  DKIM records are the proof (§4.3). The advisor's alternative is a
  Breeze-issued TXT challenge that must resolve before the provider object is
  created: it removes squatting and unproven provider objects entirely, at the
  cost of a second DNS change and wait for every partner. Additive later.
- **D7 — `static` adapter for self-hosted.** Recommend **yes**. It amends the
  2026-09-10 "SMTP = unsupported" decision for self-hosted only. Without it,
  per-stream senders exist only for the minority of self-hosters on Resend,
  while the SMTP majority, who can already authorise any From domain on their
  own relay, get nothing. The adapter makes no external calls and adds one env
  var. The alternative is to ship `resend` only and revisit on demand.

## 13. Error handling

| Failure | Behaviour |
|---|---|
| Provider down during provisioning | Row stays `provisioning`; the job retries with backoff; the UI keeps the "preparing" state and shows a delay notice after 2 min. |
| Provider refuses the domain | `failed` with `provider_conflict`, `provider_rejected` or `quota_exhausted`. `quota_exhausted` also raises an ops alert: it means the plan's domain cap was hit. |
| Crash between provider create and the local update | Retry hits "already exists", adopts by name (§5.1). |
| DNS removed after verification | `at_risk`, the partner is notified, mail keeps flowing with fallback; `failed` after the provider's 72 h. |
| Partner lane paused or rate-limited | `lane_unavailable` → platform lane per message; ops alert on the first occurrence per hour. |
| Provider delete fails | The row stays `removing`, or the outbox row backs off; ops alert after 10 attempts. |
| Partner cascade-deleted with live domains | `releaseSendingDomainsForPartner` writes outbox rows first; a path that skips it aborts on the release guard. |
| Partner suspended or restricted | Resolution falls to the platform lane on the next send. Provider domains are kept; a platform admin can force-release. |
| `static`: the relay refuses the custom sender | At setup: the test send fails, the row stays `pending` with the relay's error, and nothing is sent from it. Later (rights revoked): `domain_unusable` → the message goes out from `EMAIL_FROM`, and the row shows the refusal as `last_send_error` so the operator can fix SendAs rights or the relay's allowed senders. The domain stays `verified`: Breeze cannot tell a permanent refusal from a transient one. |
| Self-hosted removes a domain that pre-existed in their provider account | Local row deleted; the provider domain is untouched (`provider_managed = false`). |
| Operator removes a domain from `EMAIL_DOMAINS_STATIC_ALLOWED` | On the next boot, rows for it move to `failed` / `provider_rejected`; sends fall back to `EMAIL_FROM`. |

## 14. Testing

- **Validators** (`packages/shared`): table-driven domain and identity cases,
  including IDN, public suffix, platform domains, display-name spoofs.
- **Adapter contract tests**: one suite run against `fake`, `static` and, with
  a mocked SDK, `resend`. Status mapping, record normalisation, the four
  find-then-create cases (§5.1), 404-as-success delete, send-error
  classification including SMTP sender refusals. A recorded-fixture test pins
  the unverified items in §0.2.
- **Never delete what we did not create**: a row adopted with
  `provider_managed = false` goes through removal, partner release and
  failed-row expiry, and `deleteDomain` is asserted never called and no outbox
  row written. This is the test that protects a self-hoster's primary domain.
- **Deployment-mode matrix** (`config/validate.test.ts` and resolver tests),
  hosted × self-hosted: all new env unset boots and resolves everything to
  the platform lane; `static` refused on hosted; identical keys refused on
  hosted and accepted on self-hosted; the platform-domain rule rejects
  `2breeze.app` on hosted and accepts the `EMAIL_FROM` domain on self-hosted;
  the send cap defaults per mode; trust mode `off` leaves every partner
  eligible.
- **Transport matrix for `static`**: the partner-lane send with a custom From
  through each platform transport (`smtp`, `mailgun`, `resend`), and the
  fallback when the transport refuses the sender.
- **State machine**: every `sync-domain` transition, idempotent re-runs, crash
  recovery, cadence, failed-row expiry.
- **Sender resolution**: the eligibility matrix (lane off, allowlist,
  status, trust state × trust mode, identity missing, each domain status, cap),
  Reply-To precedence, null `partnerId`.
- **W01 golden test**: for every purpose, the rendered From, Reply-To and
  headers equal what the send site produced before the change, under each
  `EMAIL_PROVIDER`. This is the "upgrade changes nothing" guarantee in code.
- **`sendEmail`**: each error class; an ambiguous failure never reaches the
  second lane. The three tests that pin the literal platform From
  (`email.test.ts`, `invoiceResend.test.ts`, `quoteLifecycle.test.ts`) gain
  partner-lane cases and keep their fallback assertions.
- **Integration, real Postgres**:
  `partnerSendingDomainsRls.integration.test.ts` — cross-partner forge (42501),
  org-scope reads see zero rows, `UNIQUE (domain)` across partners, the
  composite FK rejects a cross-partner identity, the release guard raises on a
  row that still owns a provider domain, `cascadeDeletePartner` succeeds and
  leaves an outbox row, the outbox is invisible outside system scope.
  Resolution is exercised from an org-scoped context and from the
  unauthenticated portal route, because a mocked DB cannot see the zero-row
  failure.
- **Loop prevention**: own Message-ID ignored; a technician writing from the
  identity address is not.
- **E2E (Playwright, `fake` provider)**: add → records appear → check → verified
  → configure `support` → test send recorded → remove. Plus the not-eligible
  state.
- **Lab check before hosted enablement**: a real subdomain on the hosted
  partner-lane account; confirm `dkim=pass` with `header.d` = the partner domain
  and DMARC pass at Gmail and Microsoft 365; customer reply lands on the ticket;
  DKIM record removal drills `at_risk` → `failed` → fallback.

## 15. Waves

| Wave | Content | Hosted state after merge |
|---|---|---|
| **W01 — Sender contract** | `MAIL_PURPOSES` registry, required `purpose` on `sendEmail`, raw `from` removed, every send site classified per §8.2, registry property tests. `resolveSender` exists and always returns the platform lane. | **No behaviour change.** Every email is byte-identical to today. |
| **W02 — Foundation A** | Migration and schema (three tables, RLS, release guard), allowlist registrations, shared validators and DTOs, env and boot validation, `EmailDomainProvider` with `resend`, `static` and `fake` adapters, `custom_sending_domain` capability, provider-release hooks in `cascadeDeletePartner` and `finalizePartnerOffboarding`. | Dark: provider unset. |
| **W03 — Foundation B** | Domain service, `sending-domains` worker and cadence, partner and admin routes, outbox drain, audit, status-transition mail, drift report. | Dark: provider unset. |
| **W04 — Partner lane** | The partner-lane branch of `resolveSender`, partner-lane transport, fallback semantics, daily cap, `X-Breeze-Outbound` and the loop-prevention rules. | Dark: provider unset. |
| **W05 — Web UI and docs** | Settings tab (DNS and `static` variants), identities, test send, i18n, E2E, `apps/docs` page, and the self-hosting guide (§16.2). | Enabled for allow-listed partners only. Dogfood on OliveTech. Self-hosters can opt in from this release. |
| **W06 — Feedback and abuse** | Delivery webhooks, daily stats, automatic suspension, abuse signals, evidence-card entry, admin metrics. | Allowlist removed: general availability for trusted partners. |
| **Later, own spec** | SES adapter, SES tenants per partner, regional cutover. | |

W01 → W02 → W03 → W04 are serial: W02's `static` and `fake` adapters hand a
message with a custom From to the platform transport through the `deliverRaw`
entry point W01 introduces, and W03 calls what W02 defines. W05 may start once
W03 has merged (its E2E needs W04); W06 after W04. W01 has the widest diff and
the lowest risk: its review artefact is the §8.2 table, and its acceptance test
is that no rendered email changes. W02, W03, W04 and W06 touch tenancy, the
partner cascade, the send path and the abuse surface: full rigor, contract
suites before each PR. The wave split and numbering were settled with the
implementation plans (`docs/superpowers/plans/integrations/2026-09-17-partner-sending-domains.md`),
which supersede this table where they differ.

## 16. Rollout

### 16.1 Hosted

1. Create the partner-lane Resend teams (US, and EU in `eu-west-1`), Pro plan,
   `full_access` keys. Add the env vars to both droplets' `.env` **and** the
   compose `environment:` mapping.
2. Merge W01–W05 with the provider unset. Nothing changes for any tenant.
3. Confirm `PARTNER_TRUST_MODE=enforce` on both regions. Set the provider and
   an allowlist containing OliveTech. Run the lab check (§14) on a
   LanternOps-owned subdomain.
4. Merge W06, watch one week of stats on the allow-listed partners, clear the
   allowlist.
5. Close #4199 once the 2026-09-10 SPF/DMARC fix is confirmed against a fresh
   verification email. #3363 (no MX and no Reply-To on `2breeze.app`) is not
   fixed by this feature and stays open: partners without a custom domain still
   send from the shared address.

### 16.2 Self-hosted

Self-hosters upgrade on their own schedule and read the release notes, not this
spec, so the guarantees have to hold without any action from them.

- **Upgrading is a no-op.** The migration creates three empty tables. No new
  env var is required, no existing one changes meaning, the worker is not
  registered, the settings tab is hidden, and the W01 golden test proves every
  email is unchanged. The GitHub Release body (the `release` skill's
  self-hoster section) says exactly that, and lists the new optional variables.
- **Opting in, SMTP or Mailgun** (`static`): set `EMAIL_DOMAINS_PROVIDER=static`
  and `EMAIL_DOMAINS_STATIC_ALLOWED=acme.com`, restart, add the domain in
  Partner Settings, send the test email that verifies it, set the `support`
  and `billing` addresses. The guide states
  the precondition in one sentence: the relay must already be allowed to send
  as those addresses (Microsoft 365 SendAs rights, Postfix sender maps, the
  relay's verified domains), with SPF/DKIM for the domain already in place.
- **Opting in, Resend** (`resend`): a `full_access` key is needed; a
  sending-only key cannot manage domains. One account for both lanes is fine.
  A domain already verified in the account is adopted, shows as verified at
  once, and is never deleted by Breeze.
- **Docs** (W05): a "Custom sender addresses" page under `apps/docs` deploy
  docs, linked from `deploy/environment.mdx`, with the three setups side by
  side (one address via `EMAIL_FROM`; per-stream via `static`; DNS wizard via
  `resend`), plus the compose mapping lines for operators on a customised
  compose file.
- **Multi-partner self-hosted instances**: bind each `static` entry to a
  partner (`domain:partner-slug`). An unbound entry can be claimed by any
  partner on the instance.
- **Out of scope for self-hosted in this feature**: a Mailgun domain-API
  adapter (the interface allows one; `static` covers Mailgun users today), and
  partner-supplied SMTP credentials per partner on a shared instance, which
  remains excluded everywhere.
