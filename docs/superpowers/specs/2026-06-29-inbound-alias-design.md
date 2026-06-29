# Editable inbound email alias (decouple inbound address from partner slug)

**Date:** 2026-06-29
**Branch:** `ToddHebebrand/inbound-alias` (off `origin/main`)
**Status:** Design approved, pending implementation plan

## Problem

A partner's inbound ticket address is derived from `partners.slug`:
`{slug}@{TICKETS_INBOUND_DOMAIN}` (see `services/inboundEmail/resolvePartner.ts`
strategy 2, and outbound derivation in `services/inboundEmail/outboundThreading.ts`
+ `services/ticketConfigService.ts`).

The slug is set once at partner creation (auto-generated from the company name) and
is **not editable by partner admins** — `PATCH /orgs/partners/me` does not accept it,
and the only endpoint that does (`PATCH /partners/:id`) requires `requireScope('system')`.
So an MSP that bootstrapped with a misclassified or ugly slug (e.g. `partner-1`) is
stuck with `partner-1@theirdomain.com` as their customer-facing ticket address and
cannot fix it without operator action or a direct DB edit.

This was raised by a self-hosted MSP (SemoTech). On self-hosted, `TICKETS_INBOUND_DOMAIN`
is already the MSP's own domain, so they do **not** need per-partner custom domains
(the dormant `partner_inbound_domains` "Model-B" path). They only need the **local-part**
to be editable.

The slug also carries unrelated duties — portal URL identity and outbound email
threading anchors — so the fix is to **decouple the inbound mailbox name from the slug**,
not to make the slug itself freely mutable.

## Goals

- Partner admins can self-serve an editable inbound local-part without operator/DB access.
- Changing it never strands a previously-published address or breaks in-flight threads.
- No data migration/backfill; existing partners behave exactly as today until they opt in.
- Slug retains its URL-identity role, untouched.

## Non-goals

- Per-partner custom inbound **domains** (Model-B / `partner_inbound_domains`). Out of scope.
- Making `partners.slug` itself editable.
- Any change to the Mailgun webhook ingestion / HMAC path.

## Design

### Data model

Add a nullable column to the `partners` table (`apps/api/src/db/schema/orgs.ts`):

```
inbound_local_part: varchar('inbound_local_part', { length: 63 })  // nullable
```

`NULL` means "fall back to slug." No backfill — existing rows stay `NULL` and behave
unchanged. A non-unique index is sufficient for the resolver lookup; global uniqueness
is enforced at write time (see API), not by a DB constraint, because the uniqueness rule
spans **both** `slug` and `inbound_local_part` across partners and cannot be expressed as
a single-column unique index.

Migration: additive `ALTER TABLE partners ADD COLUMN inbound_local_part varchar(63)`,
reversible with `DROP COLUMN`.

### Inbound resolver — `services/inboundEmail/resolvePartner.ts`, strategy (2)

Match the recipient local-part against the alias **OR** the slug, within
`TICKETS_INBOUND_DOMAIN`:

```
where (partners.inbound_local_part == local) OR (partners.slug == local)
```

This delivers the "old address keeps working forever" requirement: the slug remains a
valid recipient even after the alias is set/changed. Strategy (1) (`partner_inbound_domains`)
is unchanged.

### Outbound — `outboundThreading.ts` (`partnerInboundAddress`) + `ticketConfigService.ts`

Build the From/Reply-To from `inbound_local_part ?? slug`. Once an alias is set, new
replies are sent from the alias; inbound still accepts both alias and slug.

### API — `PATCH /orgs/partners/me` (`apps/api/src/routes/orgs.ts`)

Add `inboundLocalPart` to `updatePartnerSettingsSchema`. The route already enforces
`requireScope('partner')` + `requireOrgWrite` + `requireMfa()`.

Validation:
- Format: `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, lowercase, max length 63. Valid as both
  an email local-part and a URL segment.
- Reserved denylist (rejected): `postmaster`, `abuse`, `noreply`, `no-reply`,
  `mailer-daemon`, `webmaster`. (It becomes a public mailbox name.)
- Uniqueness: reject if any **other** partner has `slug == value` OR
  `inbound_local_part == value`. Returns HTTP 409 on collision (so an alias can never
  shadow another tenant's address). On a single-tenant self-hosted instance this is
  trivially satisfied.
- Allow clearing (set back to `NULL`) to revert to slug-derived behavior.

### UI — `apps/web/src/components/settings/InboundEmailCard.tsx`

Replace the read-only inbound address display with an editable local-part input:
- Live preview of `{value}@{domain}` (domain from existing config).
- Inline format + uniqueness validation (surface the 409 as a field error).
- Confirmation before save: "Customers using your current address will still reach you;
  new replies will be sent from the new address."
- When unset, the field shows the slug-derived value as the effective current address.

## Testing

- `resolvePartner`: resolves by alias; still resolves by legacy slug after an alias is set;
  unknown local-part returns null.
- Outbound: `partnerInboundAddress` prefers alias, falls back to slug when `NULL`.
- `PATCH /orgs/partners/me`: accepts a valid alias; rejects bad format (422); rejects
  reserved word; rejects collision with another partner's slug or alias (409); accepts
  clearing to `NULL`.
- Migration up/down is reversible.

## Rollout

Additive and backward-compatible. Ships dark for existing partners (all `NULL`) until an
admin sets a value. No env-var or operator action required to enable.
