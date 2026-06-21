# Ticketing Phase 5 — Email-to-Ticket Customer Routing

**Status:** Design approved, ready for implementation plan
**Date:** 2026-06-20
**Depends on:** Phase 4 email-to-ticket (`2026-06-13-ticketing-phase4-email-to-ticket-design.md`)

## Problem

Phase 4 shipped inbound email-to-ticket, but the **org-resolution layer is incomplete**. An inbound email resolves to a **partner** (via the MSP's branded inbound domain or `{slug}@TICKETS_INBOUND_DOMAIN`), but the **customer organization** is resolved *only* by matching the sender's address to an existing `portal_users` row. Consequences:

- Email from `bob@acme.com`, where Bob is not yet a portal user, **quarantines** — even though `acme.com` is obviously the ACME customer. An admin must manually pick the org in the review queue and convert.
- The settings UI has a **"Default triage organization" picker literally labeled "(reserved for future use)"** — wired to nothing.
- There is **no way to map a customer's sender domain → a customer org**.

This phase completes the org-resolution layer: customer-domain routing, a triage-org fallback, and configurable onboarding of unknown senders.

## Scope

In scope:
1. **Customer domain → org mapping** — an MSP maps a customer sender domain (`acme.com`) to one of their customer orgs, so inbound mail from anyone at that domain auto-routes to the right customer.
2. **Triage-org fallback** — wire the existing `defaultTriageOrgId` picker so unmapped/unknown senders can route to a configured catch-all org instead of always quarantining.
3. **Onboarding unknown senders** — when a domain match routes a ticket, optionally auto-create a contact (`portal_users` row) for the sender so future replies thread and attribute correctly.

Out of scope (unchanged from Phase 4 deferrals):
- Branded inbound-domain DNS-verification wizard ("Model B", the `partner_inbound_domains.verificationStatus`/`dnsRecords` flow).
- Per-org *inbound* addresses (recipient-side). This phase is about the **sender** domain.
- Changes to thread-matching/reopen logic.

## Key decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Where does the sender-domain mapping live? | **New table** `customer_email_domains`, not a column on `partner_inbound_domains`. Recipient-domain (MSP inbound address) and sender-domain (customer identity) are semantically distinct with different uniqueness rules. |
| Does a domain match auto-create the ticket? | **Always.** That is the point of mapping the domain. |
| What is toggleable? | **Only contact/portal-user creation** — it has login/notification side effects. Per-domain-row `autoCreateContact` flag (default on). |
| Triage-org fallback default | **Off.** Opt-in via a `triageUnknownSenders` boolean + the `defaultTriageOrgId` picker. Both live in `partners.settings` JSONB (`settings.ticketing.inbound`) — no column/migration. When off, behavior is unchanged (quarantine). |
| Spoofing guard | **Reuse the existing gate.** `inboundEmailService.ts` already quarantines unmatched emails unless `senderAuth.verified` (Mailgun **DMARC-pass**, the only From-domain-aligned signal). The new domain/triage routing sits behind that gate and inherits it — no new gate is built. |

## Org-resolution precedence (new-ticket path)

In `inboundEmailService.ts`, for an inbound email that is **not** a reply to a live thread, resolve the org in this order. First match wins:

1. **Known sender** — sender address matches a `portal_users` row in the resolved partner → that user's home org. *(Existing. Most specific — wins over domain mapping so a user who belongs to a sub-org isn't overridden by a broader domain rule.)*
2. **Sender domain** — sender's email domain matches an active `customer_email_domains` row for the partner → that org. *(NEW.)* Always create the ticket. If that row's `autoCreateContact` is on, create a contact and set it as the submitter.
3. **Triage fallback** — partner has `triageUnknownSenders` enabled **and** `defaultTriageOrgId` set → that catch-all org. *(NEW wiring.)* Create the ticket; **no** contact auto-create (the customer is unknown).
4. **Quarantine** — none matched. *(Existing.)*

**Spoofing gate (already present):** `inboundEmailService.ts` already requires `senderAuth.verified` (Mailgun DMARC-pass) before an unmatched email reaches sender resolution — unverified senders quarantine with `'unverified sender (SPF/DKIM/DMARC)'`. The new steps 2–3 are inserted *after* that existing gate, so they inherit it: a forged `From: @acme.com` that fails DMARC never reaches domain routing. DMARC-pass is specifically the From-domain-aligned signal (a standalone SPF/DKIM pass is deliberately not treated as verified), which is exactly the trust we need to route on the From domain. No new gate is added.

## Data model — `customer_email_domains` (new table)

Org-routing table for inbound sender domains. Partner-managed (the MSP configures all its customers' domains in one settings surface).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `partner_id` | uuid not null → partners | RLS axis |
| `org_id` | uuid not null | Target customer org (denormalized for routing + cascade) |
| `domain` | text not null | Lowercased hostname, e.g. `acme.com` |
| `auto_create_contact` | boolean not null default true | Toggle for sender contact creation |
| `is_active` | boolean not null default true | Soft enable/disable |
| `created_by` | uuid → users | |
| `created_at` / `updated_at` | timestamptz | |

Constraints & indexes:
- **Composite FK** `(org_id, partner_id) → organizations(id, partner_id)` — DB-enforces the mapped org belongs to the partner (eliminates the cross-tenant-mapping IDOR at the database layer; mirrors the `ticket_categories` composite-FK pattern).
- **Unique** `(partner_id, domain)` — one org per domain within a partner.
- Index on `(partner_id, is_active)` for the resolver's lookup.

### Tenancy / RLS

- **Shape:** Partner-axis (`breeze_has_partner_access(partner_id)`) **plus** denormalized `org_id`.
- Because it is partner-axis but carries `org_id`, per the established trap it must be added to **both** `PARTNER_TENANT_TABLES` **and** `ORG_AXIS_POLICY_EXCLUDED_TABLES` in `rls-coverage.integration.test.ts`, or the org-axis coverage check fails. (Precedent: `time_entries`, `huntress_*`.)
- Add to org **and** partner cascade-delete order lists (`tenantCascade.ts`), inserted at the correct `localeCompare` slot, with a matching `core.ts`/integration cascade contract entry. RLS-coverage passing ≠ cascade coverage.
- RLS forge test (functional `breeze_app` insert) proving cross-partner **and** cross-org isolation — the contract test alone does not catch a missing second axis.
- Migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `pg_policies` existence checks), date-prefixed, no inner `BEGIN/COMMIT`, no `gen_random_bytes`.

### Freemail guard

Reject mapping free-provider domains (`gmail.com`, `outlook.com`, `hotmail.com`, `yahoo.com`, `icloud.com`, `aol.com`, `proton.me`, …) at the API with a clear error. Mapping a free-provider domain would route every consumer sender to a single org. Maintain the blocklist in `packages/shared`.

## Resolver + auto-provisioning

- New `resolveOrgBySenderDomain(fromAddress, partnerId): { orgId, autoCreateContact } | null` in `apps/api/src/services/inboundEmail/` (system-context; used by the worker). Keyed on the **sender** (From) domain — kept separate from `resolvePartnerByRecipient`, which keys on the **recipient**.
- `inboundEmailService.ts` new-ticket path calls it after the existing portal-user lookup fails and before quarantine, applying the precedence and SPF/DKIM gate above.
- **Auto-created contact** = a `portal_users` row with `org_id`, email, display name (from the `From` header), and `passwordHash: null`. A null hash is inherently non-login (the Entra path already creates password-less rows, so this is an existing shape, not a new one) — explicitly not a portal-login bypass. `authMethod` stays `'password'`, `status` `'active'` so the contact can receive notifications/autoresponses. The ticket's `submittedBy` points at it; the next email from the same sender then matches precedence step 1. (No `source` column exists on `portal_users` and none is added — the table is auth-sensitive and left unchanged.)

## API (partner/admin-scoped, under `ticket-config`)

- `GET /ticket-config/inbound-domains` — list mappings for the partner, joined with org names.
- `POST /ticket-config/inbound-domains` — create `{ domain, orgId, autoCreateContact }`.
- `PATCH /ticket-config/inbound-domains/:id` — update `{ orgId?, autoCreateContact?, isActive? }`.
- `DELETE /ticket-config/inbound-domains/:id` — remove.
- Wire `defaultTriageOrgId` + new `triageUnknownSenders` boolean into the existing config `GET`/`PATCH`.

Authz:
- Partner-admin scope (`requirePermission`); org-scope users have no access (partner config surface).
- Server-side, `orgId` must belong to the caller's partner — cross-tenant attempt → **403** (explicit IDOR test, in addition to the DB composite FK).
- Validate/normalize `domain` (lowercase, hostname shape, freemail rejection) in the shared Zod schema.

## Web UI

`apps/web/src/components/settings/` (extend `InboundEmailCard.tsx` or add `CustomerDomainsCard.tsx`):
- **"Customer email domains"** table — domain → org rows; add/edit/delete; per-row **auto-create-contact** toggle.
- Un-stub the **"Default triage organization"** picker (remove "reserved for future use"); add a **"Route unknown senders to triage org"** toggle bound to `triageUnknownSenders`.
- Mutations go through `runAction` (success/failure always surfaced).
- The review queue is unchanged but now quarantines fewer emails.

## Testing

- **RLS forge** (`*.integration.test.ts`, `breeze_app`): cross-partner and cross-org isolation on `customer_email_domains`; re-seed fixtures per `it` (no memoized fixture).
- **rls-coverage** allowlist updates: `PARTNER_TENANT_TABLES` + `ORG_AXIS_POLICY_EXCLUDED_TABLES`.
- **tenantCascade** contract: org + partner cascade order entries at correct `localeCompare` slot.
- **Resolver unit tests:** precedence order; freemail rejection; SPF/DKIM-fail → quarantine even on domain match; `autoCreateContact` on vs off.
- **Inbound integration:** mapped-domain email auto-creates a ticket in the correct org; auto-created contact then matches as a known sender on the next email; triage fallback routes when enabled and quarantines when not.
- **Config route tests:** CRUD + cross-tenant **403** (partner A cannot map a domain to partner B's org); `runAction` failure surfacing in the web layer.
- **Validator tests:** domain normalization + freemail blocklist.

## Migration & rollout notes

- Single additive migration creating `customer_email_domains` + RLS policies (idempotent, date-prefixed `2026-06-20-*`). The composite FK `(org_id, partner_id) → organizations(id, partner_id)` reuses the unique constraint already present on `organizations(id, partner_id)` (used by `ticket_categories` and `users`); confirm it exists during Task 1.
- `triageUnknownSenders` is **not** a column — it lives in `partners.settings` JSONB at `settings.ticketing.inbound.triageUnknownSenders`, alongside the existing `defaultTriageOrgId`. No migration; default-absent reads as `false`.
- No backfill. Behavior is opt-in: with no domain mappings and triage disabled, routing is identical to Phase 4.
- Resolution findings (verified during planning): `defaultTriageOrgId` is persisted in `partners.settings` JSONB; the DMARC-pass auth signal is on `NormalizedInboundEmail.senderAuth.verified` and already gates the unmatched-email path at `inboundEmailService.ts:172`.
