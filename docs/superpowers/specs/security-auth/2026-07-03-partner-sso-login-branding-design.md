# Partner-Scope SSO + Login-Page Branding — Design

**Issue:** #2183 (win-wxx, self-hosted MSP). **Epic alignment:** #2135 partner-wide-first dual-axis playbook.
**Status:** Approved design, pre-implementation. **Date:** 2026-07-03.

## Problem

All live SSO is org-axis: `sso_providers.org_id` is NOT NULL, `defaultRoleId` must be an
org-scoped role, and `/sso/check/:orgId` needs an org before a login button can render. An
MSP's own technicians (partner-scope users, `users.orgId IS NULL`) have no SSO path into the
partner dashboard. `partners.ssoConfig` / `organizations.ssoConfig` jsonb columns are
write-only placeholders (no read call sites; responses project them out). The login shell
(`AuthShellBranded.astro`) is hardcoded Breeze branding and marketing copy, which reads
wrong on single-partner self-hosted instances.

## Scope decisions (settled with Todd, 2026-07-03)

- **Self-hosted first.** v1 targets single-partner instances; hosted multi-partner slug
  discovery (`/login/:partnerSlug`) is deferred, but the public endpoint shape is designed
  so the slug variant slots in without rework.
- **Approach A:** dual-axis extension of the existing `sso_providers` table per the #2135
  playbook — NOT a separate `partner_sso_providers` table, NOT the dormant jsonb columns.
- **MFA mirrors org SSO:** per-provider `trustsIdpMfa` + `amr` claim check sets the JWT
  `mfa` claim; role-level `forceMfa` (428 enrollment gate) backstops.
- **Identity-first only in v1:** no JIT/auto-provisioning through partner providers. Users
  must already exist (invited). JIT is an additive fast-follow reusing org machinery
  (`sso_verified_domains` stays org-only until then).
- **Minimal branding:** logo URL + accent color + headline. No custom CSS (XSS-adjacent),
  no favicon/custom-domain work in v1.
- **No MSAL / no new auth libraries.** The `jose`-based engine in `services/sso.ts`
  (discovery, PKCE, JWKS id_token verification, SAML helpers, provider presets) is reused
  unchanged. Entra remains a preset, not a dependency.
- **Password-holding users are never auto-linked by email** (settled with Todd,
  2026-07-03): login-path auto-link applies only to passwordless users with no link to a
  different provider — the same safe-link conditions org SSO uses. Everyone else connects
  their identity through an authenticated self-service **Connect SSO** flow (initiated
  from their own security settings, `requireMfa()`-gated, full id_token verification +
  email-match before the `user_sso_identities` row is created; works for both org-axis
  and partner-axis providers). The `sso_link_required` login error directs users there.

## 1. Data model & migration

One migration (idempotent, RLS in same file, playbook reference:
`2026-06-27-config-policies-partner-ownership.sql`):

- `sso_providers`: `ADD COLUMN partner_id uuid REFERENCES partners(id)`, relax `org_id` to
  nullable, `sso_providers_one_owner_chk` CHECK `((org_id IS NULL) <> (partner_id IS NULL))`,
  index on `partner_id`, drop org-only RLS policies and create ONE dual-axis policy:
  `system OR breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id)`
  (FORCE kept).
- `user_sso_identities`, `sso_sessions`: unchanged — they key off `provider_id`/`user_id`;
  the provider row carries ownership.
- `sso_verified_domains`: unchanged in v1 (gates JIT, which is out of scope).
- **New `partner_branding`** (deliberately partner-only, NOT dual-axis — org login branding
  already exists as `portal_branding`): `partner_id uuid PK REFERENCES partners(id)`,
  `logo_url text`, `accent_color varchar(7)`, `headline varchar(120)`, timestamps.
  Shape-3 RLS (`breeze_has_partner_access(partner_id)`), FORCE.
- **Deprecations:** remove `ssoConfig` from org/partner create+update Zod schemas
  (`routes/orgs.ts:60,120`) so writes stop. Columns remain (never edit shipped
  migrations); a later cleanup migration may drop them.

**Allowlists/tests to register:** `sso_providers` → `DUAL_AXIS_TENANT_TABLES`;
`partner_branding` → `PARTNER_TENANT_TABLES` (both in
`rls-coverage.integration.test.ts`). Tenant-cascade sweep must cover `partner_branding`.

## 2. Auth flow

- **Entry:** `GET /sso/login/partner/:partnerId` alongside existing `GET /sso/login/:orgId`;
  mounted before it so `partner` never parses as an orgId. Same `sso_sessions`
  state/nonce/PKCE machinery.
- **Callback:** existing `GET /sso/callback` branches on the provider row's owner axis.
  Partner-axis path: verify id_token exactly as today (JWKS, issuer, nonce), then
  identity-first resolution ONLY —
  1. match `user_sso_identities` for this provider;
  2. else match verified email against users WHERE `partner_id = provider.partner_id`
     AND `org_id IS NULL` (partner staff only; org users never resolve through a partner
     provider) and auto-link ONLY under the safe-link conditions (no password, no link
     to a different provider); a password-holding match error-redirects with
     `sso_link_required`, pointing at the Connect SSO flow;
  3. else error-redirect with reason `invite_required` (no user creation).
- **Connect SSO (self-service linking):** an authenticated, `requireMfa()`-gated
  `POST /sso/link/start/:providerId` starts an IdP round-trip using the same
  `sso_sessions` state/PKCE machinery with a `link_user_id` marker; the callback
  recognizes link mode and, after full id_token verification, an email match against
  the linking user, and an identity-in-use check, creates the `user_sso_identities`
  row for the CURRENT user (no token minting). Audited (`sso.identity.linked`).
  Surfaced as a "Connect SSO" card in the user's own security settings. Both axes.
- **Role & token:** provider-write-time validation requires `defaultRoleId` to be a
  partner-scoped role when `partner_id` is set (mirror of the org check). In v1 the
  default role is validated and stored but NEVER applied at login — identity-first means
  the user's existing `partner_users` membership (incl. `orgAccess`) is always
  authoritative, and users without membership are rejected (do not fall back; see the
  membershipless-user system-scope-token bug class). The column becomes live only when
  JIT ships. SSO never escalates beyond existing membership.
  Tokens minted via existing `createTokenPair` with `scope: 'partner'`; refresh-cookie
  exchange via the existing one-time `#ssoCode` flow.
- **MFA:** `trustsIdpMfa` + `amr` → JWT `mfa` claim (unchanged code path); `forceMfa`
  roles still hit the 428 enrollment gate without it.
- **enforceSSO:** partner provider with `enforceSSO` suppresses password login for that
  partner's staff via the existing `ssoPolicy` mechanism; break-glass preserved while
  status is `testing` (same testing→active gate as org SSO).

## 3. Login page & branding surface

- **New public endpoint `GET /auth/login-context`** (unauthenticated, rate-limited,
  cacheable). Single-partner instance → `{ branding: {logoUrl, accentColor, headline} |
  null, partnerSso: { available, providerName, loginUrl } | null }` for that partner.
  Multi-partner instance → `{ branding: null, partnerSso: null }` (stock Breeze page);
  the future slug variant returns the same shape resolved by slug. Never leaks provider
  config beyond name + login URL.
- **Web:** `LoginPage.tsx` fetches login-context (same pattern as the `cfAccessLogin`
  config check at `LoginPage.tsx:38-58`). `AuthShellBranded.astro` becomes prop-driven:
  branding present → swap logo/accent/headline, drop hardcoded marketing copy.
  `partnerSso.available` → "Sign in with {providerName}" button above the password form.

## 4. Admin API & UI

- `/sso/providers` CRUD gains `ownerScope: 'organization' | 'partner'` on create
  (update schema `.omit({ ownerScope: true })`). Partner-scope writes gated on
  `canManagePartnerWidePolicies(auth)` (`services/partnerWideAccess.ts`); partner id
  derived from the caller's token, never the request body. Existing `requireMfa()` on
  SSO admin routes stays.
- SSO settings UI: create-only ownership selector + "Partner" badge (pattern:
  `apps/web/src/components/software/PolicyForm.tsx`). Presets, testing→active flow,
  test-login button inherit unchanged.
- New "Login Branding" card under partner settings: logo URL, accent color (hex,
  validated), headline (length-capped) + live preview; mutations via `runAction`;
  strict Zod (no `z.any()`).

## 5. Security & error handling

- **Axis confusion:** callback derives user pool, role scope, and token scope from the
  provider row's axis; a partner provider can never mint org-scoped tokens or resolve
  org-bound users. Enforced in code + forge tests.
- **Tenant leakage:** login-context reveals branding/SSO only on single-partner
  instances; multi-partner returns nulls.
- **Escalation:** `defaultRoleId` scope validated at write time; login never grants
  beyond existing membership (identity-first).
- **Redirect/interception:** unchanged org-SSO protections (one-time `#ssoCode`, PKCE,
  nonce, SSRF guards on discovery URLs).
- **Lockout:** break-glass password login preserved in `testing` status; `enforceSSO`
  is an explicit opt-in. All SSO admin mutations via `writeRouteAudit`; logins audited
  as `user.login` with `method: 'sso-partner'`.
- **Error paths:** callback failures redirect with typed reason codes
  (`invite_required`, `provider_error`, `state_mismatch`), never raw errors; login rate
  limits (per-IP and per-IP+identity) apply to the new entry point.

## 6. Testing

- `ssoProvidersPartnerRls.integration.test.ts`: cross-partner forge (42501), XOR
  (23514), org↔partner visibility isolation, functional second-axis insert.
- `partner_branding` RLS forge + cascade coverage.
- Route tests: ownerScope create/gate, partner-scoped defaultRoleId validation,
  update-omits-ownerScope.
- Callback unit tests: partner staff resolves; same-email org user does NOT; unknown
  identity → `invite_required`; `trustsIdpMfa`/`amr` → `mfa` claim.
- `login-context`: single-partner with/without branding; multi-partner nulls.
- Web: branded shell render, SSO button, `no-silent-mutations` for the branding card.
- Connect SSO: link-start auth/MFA/axis-pool gates; link-mode callback (email
  mismatch rejected, identity-in-use rejected, happy path links the session user).
- Real-DB e2e integration: partner-axis provider login mints a `scope: 'partner'`
  token; a password-holding user hits `sso_link_required`, links via Connect SSO,
  then logs in via SSO successfully.

## Out of scope (recorded)

JIT for partner providers (+ partner-axis `sso_verified_domains`), `/login/:partnerSlug`
hosted discovery, group/claim-based role mapping, SCIM, favicon/custom-domain/custom-CSS
branding, dropping the deprecated `ssoConfig` columns.
