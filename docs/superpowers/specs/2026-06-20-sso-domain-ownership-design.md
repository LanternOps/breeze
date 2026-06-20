# SSO Domain-Ownership Verification + `sso:admin` — Design

**Date:** 2026-06-20
**Status:** Approved design (pre-implementation)
**Area:** `apps/api` SSO (OIDC), permissions, `apps/web` settings UI

## Provenance

From the security-review playbook (`internal/security-review-playbook.md`), entry **#2 — Core authentication** (DEEP two-pass review). That review found an SSO account-takeover cluster whose root cause (H-2) is: a **malicious or compromised org-admin** can point their own org's OIDC provider at an **attacker-controlled IdP** and impersonate any co-member, because the callback linked accounts by the **global-unique email** — and id_token signature / `email_verified` don't stop an IdP that signs with its own JWKS.

The exploitable and steady-state parts already shipped:

- **#1655** — mandatory id_token signature verification; identity derived from the verified token (C-1/C-2).
- **#1671** — **identity-first lookup + safe JIT linking** (H-2/H-3 residual): once a user is linked, only `(provider, external sub)` authenticates them; an SSO assertion will not silently link to a password account or one linked to a different provider.
- **#1677** — MFA TOTP replay protection.
- **#1680** — SSO IdP-MFA signal (H-1).

This document specs the **last deferred item: the H-2 root cause.** #1671 neutralized the *steady-state* takeover, but a malicious org-admin can still assert/provision emails **in a domain the org does not own**. This is the defense-in-depth root-cause hardening.

## Goals

1. Gate SSO **provisioning / JIT-linking** on a **DNS-verified** email domain — an org can only auto-create or first-time-link a user whose email domain it has proven it owns.
2. Make "point the org at an IdP" a distinct, higher-trust **`sso:admin`** capability (separate from general `orgs:write`).

Non-goals (explicitly out of scope): SAML support (OIDC-only, as today); changing the `(provider, sub)` identity-first model from #1671; auto-revoking verification on transient DNS failure.

## Scope decisions (from brainstorming)

- **Enforcement model:** gate **provisioning/linking only**. An unverified domain → SSO login refused for that email (`sso_domain_unverified`). Already-linked `(provider, sub)` users are never domain-checked.
- **Verification method:** **DNS TXT record** (self-serve; uses Node DNS resolution with a timeout).
- **IdP-config gating:** a **new `sso:admin` permission** gates provider create/update/activate + domain management.
- **Role backfill:** the migration grants `sso:admin` to **every role that currently holds `orgs:write`** — non-breaking on day one; orgs can tighten later.
- **Revocation posture:** verification is **sticky**; a periodic re-check audits + notifies on drift but does **not** auto-unverify in v1 (operator knob, off by default).
- **Rollout:** **per-org auto-enforce** — enforcement is active for an org only once it has ≥1 verified domain; an org with zero verified domains stays in **warn mode** (allow + audit + nudge). A global `SSO_DOMAIN_VERIFICATION_STRICT` env (default off) forces enforce-everywhere.

## Two implementation plans

The work splits into two independent, separately-shippable plans:

- **Plan A — `sso:admin` gating** (no DNS): new permission + backfill migration + apply to provider routes + change notifications. Self-contained, non-breaking.
- **Plan B — domain verification**: `sso_verified_domains` table + service + routes + callback enforcement + re-check job + admin UI.

Build A first (smaller, unblocks the gating immediately), then B.

---

## Data model

### New table `sso_verified_domains`

Org-scoped (RLS shape 1: `breeze_has_org_access(org_id)`), added to the `ORG_*` auto-discovered set and asserted by `rls-coverage.integration.test.ts`.

| column | type | notes |
|---|---|---|
| `id` | uuid pk default random | |
| `org_id` | uuid not null → organizations | tenant axis |
| `domain` | varchar(253) not null | lowercased; `UNIQUE(org_id, domain)` |
| `verification_token` | varchar not null | high-entropy; the value placed in the TXT record |
| `verified_at` | timestamp null | null = pending |
| `last_checked_at` | timestamp null | set by the periodic re-check |
| `created_by` | uuid → users | |
| `created_at` / `updated_at` | timestamp not null default now | |

Migration: idempotent (`CREATE TABLE IF NOT EXISTS`, RLS `ENABLE`+`FORCE`+policy in the same migration). Naming `YYYY-MM-DD-<slug>.sql`, sorts after the current latest.

### Relationship to existing `ssoProviders.allowedDomains`

Unchanged. `allowedDomains` remains an **optional per-provider narrowing filter** (free-text comma list, applied at the callback as today). The **security gate** is the org-scoped verified-domains set. Most orgs won't set `allowedDomains`.

---

## Plan A — `sso:admin` permission & gating

### Permission

New catalog entry `sso:admin` (resource `sso`, action `admin`).

### Applied to (replace `requirePermission(ORGS_WRITE)`, keep `requireMfa()`)

- `POST /sso/providers` (create)
- `PATCH /sso/providers/:id` (update)
- `POST /sso/providers/:id/status` (activate/deactivate)
- all `/sso/domains*` routes (Plan B)

Read routes (list/get providers) stay on their current read permission.

### Backfill migration

For every role holding `(orgs, write)`, grant `(sso, admin)` via a `role_permissions` insert that resolves-or-creates the catalog row, idempotent (`ON CONFLICT DO NOTHING`). Day-1 behavior identical; orgs can revoke `sso:admin` from junior roles afterward.

### Change notifications (defense-in-depth)

On every provider create/update/status-change: `writeRouteAudit` (extend existing) **and** an async notification to the org's admins ("SSO configuration changed by <actor>"), so a malicious/compromised config change is visible to peers.

### Plan A tests

- An `orgs:write`-only role (no `sso:admin`) → 403 on provider create/activate.
- An `sso:admin` role → succeeds.
- Backfill migration grants `(sso, admin)` to every `(orgs, write)` role; idempotent on re-run.
- Notification fires on provider change.

---

## Plan B — domain verification

### Service `services/ssoDomainVerification.ts`

One focused unit:

- `createPendingDomain(orgId, domain, userId)` → normalize + validate the domain, generate a random `verification_token`, insert a pending row, return the TXT instruction: a record with value `breeze-domain-verify=<token>` placed at **`_breeze-verify.<domain>`** (a dedicated subdomain, so we never read or depend on the domain's apex TXT, which often holds SPF/other records).
- `verifyDomain(orgId, domainId)` → resolve TXT at `_breeze-verify.<domain>` (`dns.promises.resolveTxt`, short timeout); if any returned record equals `breeze-domain-verify=<token>`, stamp `verified_at`; else stay pending. Resolution errors (NXDOMAIN/timeout) → "not verified" (fail-safe).
- `isDomainVerifiedForOrg(orgId, emailDomain)` → hot-path boolean used by the callback (`verified_at` not null).
- `orgHasAnyVerifiedDomain(orgId)` → drives the per-org enforce/warn decision.

**DNS safety:** resolving an admin-supplied domain's TXT is a *public DNS query*, not an SSRF vector (no internal-network reach); bound it with a timeout. Tokens are high-entropy and per-`(org, domain)`, so one org cannot satisfy another's challenge.

### Endpoints (all `sso:admin` + `requireMfa()`, org-scoped via `auth.canAccessOrg`)

- `POST /sso/domains` `{ domain }` → create pending; return token + TXT instructions.
- `POST /sso/domains/:id/verify` → run the DNS check now (the "Verify" button).
- `GET /sso/domains` → list with status.
- `DELETE /sso/domains/:id` → remove.

### Callback enforcement

In the SSO callback, only on the provision / JIT-link branches (the existing `(provider, sub)` link path is never domain-checked):

```
resolve user:
  existing (provider, sub) link  → log in (NO domain check)          ← unaffected
  else (provision new / JIT-link existing-by-email):
     org enforcing?  (orgHasAnyVerifiedDomain(orgId) OR SSO_DOMAIN_VERIFICATION_STRICT)
        no  → warn mode: allow + audit + notify admins ("verify domains to harden SSO")
        yes → isDomainVerifiedForOrg(orgId, emailDomain)?
                 yes → proceed
                 no  → refuse, redirect /login?error=sso_domain_unverified
```

### Rollout (non-breaking & self-tightening)

1. **Seed:** the Plan-B migration creates **pending** `sso_verified_domains` rows from each existing provider's `allowedDomains`, so admins see exactly what to verify.
2. **Per-org auto-enforce:** enforcement is active for an org only once it has ≥1 verified domain. Zero verified → warn mode (allow + audit + nudge). Verifying the first domain turns the refuse-on-unverified gate on for that org — self-serve, no flag day.
   - Orgs that never verify behave as today plus nudges; #1671 still blocks the high-value takeover for them.
3. **Operator override:** `SSO_DOMAIN_VERIFICATION_STRICT` (default off) forces enforce-everywhere.

Rationale for not hard-enforcing day 1: with no domains verified, every auto-provisioning org would break instantly.

### Periodic re-check (BullMQ)

A scheduled `ssoDomainReverify` job (cadence ~daily) re-resolves TXT for `verified_at IS NOT NULL` domains, updates `last_checked_at`; on a miss, writes an audit event + notifies `sso:admin` holders ("TXT record for <domain> no longer found") but does **not** unverify (sticky). Follows existing BullMQ patterns; jobId uses `-` separators (colon-count rule).

### Admin UI (`apps/web`, extends `SsoProviderForm` / `SsoProvidersPage`)

- "Verified domains" panel: add-domain → show the TXT record + token to copy; **Verify** button (`POST /sso/domains/:id/verify`); status badges (Pending / Verified / record-missing); delete.
- Non-blocking banner in warn mode (zero verified): "SSO provisioning isn't domain-restricted yet — verify a domain to harden it."
- `sso:admin`-gated controls (hidden/disabled for non-holders).

### Plan B tests

- **Service unit:** token gen; `verifyDomain` match / no-match / DNS-error→not-verified; `isDomainVerifiedForOrg` true/false; tokens per-`(org, domain)` (one org can't satisfy another's challenge).
- **Routes:** `sso:admin` 403 gate; org-scoping (can't manage another org's domains); create→verify happy path.
- **Callback:** provision in a **verified** domain → succeeds; provision in an **unverified** domain with the org **enforcing** → `sso_domain_unverified`; same in **warn mode** (zero verified) → allowed + audit; already-linked `(provider, sub)` → unaffected regardless.
- **Migration:** seeding pending rows from `allowedDomains`; migration-ordering (`autoMigrate.test`).
- **RLS:** `sso_verified_domains` cross-org forge rejected; added to `rls-coverage` allowlist.

---

## Error/edge handling

- DNS resolution failure / timeout → treated as not-verified (fail-safe), surfaced to the admin as "couldn't find the record yet."
- Duplicate domain for an org → `UNIQUE(org_id, domain)` conflict returned as a clean 409.
- Domain normalization: lowercase, strip whitespace/trailing dot; reject obviously invalid inputs (no `@`, must have a dot). Public-suffix-only domains (e.g. `gmail.com`) are allowed to be *attempted* but won't verify (no TXT control) — no special-casing needed.
- Pre-auth callback DB reads run under `withSystemDbAccessContext` (the established SSO-callback pattern), same as the existing provider/user lookups.

## Open questions / future knobs

- Auto-unverify after N consecutive re-check misses (off by default).
- Email-to-postmaster verification as an alternative method (deferred; DNS-only for v1).
