# Core Authentication Hardening Design

**Date:** 2026-07-11  
**Source review:** `internal/security-findings/2026-07-11-playbook-02-core-authentication.md`  
**Reviewed baseline:** `origin/main` at `944bb8d1861d65c4978b5a1b7db910d43893b972`  
**Implementation baseline:** current `origin/main` including `61d8c6886` (signup abuse detection, #2343). All work builds on it; the register-partner changes in PR 4 must integrate with the abuse-attribution capture that commit added.  
**Delivery:** Six dependency-ordered pull requests. Every pull request must be independently deployable and reviewed before the next is opened.

> **Review amendments (2026-07-11):** this revision incorporates the pre-implementation review. Changes are inline in their sections: MCP OAuth grant revocation joins the epoch primitive; the `/refresh` verifier gets an explicit epoch gate; API-key creator checks fail closed and the disabled-creator rejection moves into PR 1; SR2-08 reset generations move into PR 1; CF Access mint sites and test token helpers are named; pending-email IdP matching is specified; new tables must declare an RLS tenancy shape; PR 6 sweeps all naive client-IP readers.

## Objective

Remediate all 24 findings from the core-authentication security review by making durable database state—not Redis cache state or stale bearer claims—the authority for authentication, MFA assurance, identity recovery, SSO transactions, delegated API keys, and trusted client IPs.

The design intentionally forces a global sign-out when the epoch foundation ships. Legacy JWTs without epoch claims are rejected immediately; there is no compatibility window that preserves reviewed vulnerabilities.

## Security invariants

1. A credential issued before a relevant security-state change cannot become valid again later.
2. Redis failure can reduce availability or delay cache cleanup, but cannot restore a revoked credential.
3. Authentication mutations either commit their durable security effects atomically or fail.
4. Tenant RLS context is never established from a signed tenant claim without confirming the user still has the matching live membership.
5. System scope is never established unless the live user row still identifies a platform administrator.
6. MFA assurance is valid only for the current MFA configuration and current effective MFA policy.
7. Pending MFA, SSO, registration, verification, and recovery artifacts are single-use, short-lived, and bound to the current security generation.
8. Human-delegated API keys cannot outlive the creator's authority. Non-human automation uses an explicit service principal.
9. Client IP is derived at a trusted proxy boundary and cannot be selected by an untrusted request header.
10. Public authentication responses do not reveal whether an email belongs to an account.

## Shared durable security state

Add the following non-null integer columns to `users`, initialized to `1`:

- `auth_epoch`: advances when password, status, membership, platform privilege, verified email, or other account-wide authentication state changes.
- `mfa_epoch`: advances when a factor, recovery code set, or effective MFA configuration changes.
- `email_epoch`: advances when a pending email is requested, cancelled, replaced, or committed.
- `password_reset_epoch`: advances when a reset token is issued or any password change/reset completes.

Add `absolute_expires_at` to `refresh_token_families`. New families receive a fixed absolute lifetime; rotation may update ordinary JWT expiry and `last_used_at` but never extends `absolute_expires_at`.

Add `pending_email` and `pending_email_requested_at` to `users`. The verified `email` column remains authoritative until pending-email verification commits the change.

Access and refresh JWTs carry `auth_epoch`, `mfa_epoch`, and a stable `session_id`. The session ID is the refresh-family ID; access tokens use a `sid` claim and refresh tokens retain the existing `fam` claim. Tokens missing any required claim are invalid. Token-mint paths resolve current epochs from the database instead of accepting caller-provided values. Request middleware already loads the live user row today; it additionally rejects any epoch mismatch before setting authentication or database context, riding the existing user query rather than adding a new one.

The `/refresh` handler verifies refresh tokens itself (it is not behind the request middleware), so it must apply the same epoch gate explicitly: a refresh token missing epoch claims, or carrying stale epochs, is rejected before any rotation or minting. A stored legacy refresh token must not be able to mint fresh epoch-bearing access tokens.

**Mint sites (all must embed epochs and `sid`, none may be missed):** password login, `/refresh` rotation, MFA-verify completion, register-partner auto-login, invite accept, passkey login, SSO callback, `cfAccessLogin` middleware, and `cfAccessRedirectLogin` — plus the test token builders in `apps/api/src/__tests__/helpers.ts` and `__tests__/integration/db-utils.ts`, which must mint epoch-valid tokens and seed epoch columns on fixture users. Separate-audience token systems (viewer tokens, quote-accept, client-ai Entra, CF edge JWT verification, email-verification tokens, MCP OAuth EdDSA bearers, agent/helper/installer/portal tokens) are explicitly NOT subject to the user-JWT epoch gate; enforcement is scoped to `aud=breeze-api` user tokens.

`email_epoch` and `password_reset_epoch` are carried by their purpose-specific artifacts rather than ordinary JWTs.

## Durable revocation service

Create one database-transaction-oriented authentication lifecycle service. Its operations accept a transaction and provide narrowly scoped primitives:

- advance one or more user epochs;
- revoke every active refresh family for a user with an explicit reason and timestamp;
- revoke one current refresh family for logout;
- revoke the user's active MCP OAuth grants (the EdDSA bearer path in `bearerTokenAuth.ts` never sees user-JWT epoch claims, so `auth_epoch` advancement must also sweep OAuth grants via the existing grant-revocation machinery — otherwise invariant 1 is violated for MCP credentials);
- read the post-mutation epoch values needed by the caller.

Status changes, password changes, membership removal, email commitment, and MFA factor changes call these primitives inside the same transaction as their business mutation. A database failure rolls back the entire mutation.

Redis token cutoffs, exact-JTI markers, permission-cache invalidation, and refresh-family cache markers remain useful hot-path controls. They run after the durable commit and are retried/observed on failure, but they are not the only revocation authority.

Logout resolves the current refresh family from the refresh cookie or authenticated access-token `sid`, durably revokes it, then performs Redis cleanup. The local cookie is always cleared. If durable revocation fails, the endpoint returns a failure response and writes a failure/partial audit event rather than false success.

## Live authorization binding

Before opening RLS context:

- `scope='system'` requires `users.is_platform_admin=true` on the live row;
- organization scope requires a current `organization_users` membership matching the token organization;
- partner scope requires a current `partner_users` membership matching the token partner;
- tenant status must remain active;
- epoch checks must already have passed.

These checks cover both application mutations that advance `auth_epoch` and out-of-band database changes that cannot be assumed to call application services.

Note: the membership-less system-scope mint hole is already closed on main (`NoTenantMembershipError` in `routes/auth/helpers.ts`), and the middleware already loads the live user row with a status check. The new work here is the live `is_platform_admin` check for system scope (catches out-of-band demotion), the live partner/org membership recheck for the token's claimed tenant axis, and the epoch comparison — all riding existing per-request queries where possible, mindful of the ~25-connection production ceiling on the US database.

## MFA policy and assurance

Introduce one effective MFA-policy resolver used by middleware, login, refresh, enrollment, and factor operations. It combines role `forceMfa`, organization settings, and partner settings with the strictest applicable result. The canonical settings field is `security.allowedMethods`; the legacy/unreachable read spelling is migrated or accepted only as an input alias and never stored as a second source of truth.

When effective policy requires MFA:

- an unenrolled user receives a forced-enrollment response and never receives `mfa=true`;
- refresh cannot carry forward assurance if the current `mfa_epoch` differs;
- factor use is rejected if the method is no longer allowed;
- setup and replacement endpoints enforce the same resolver.

Pending MFA records contain user ID, authentication epoch, MFA epoch, account status expectation, method availability, and expiration. Completion reloads the user and effective policy, compares epochs/status, and atomically consumes the record before minting tokens.

### Factor enrollment and changes

Initial enrollment for an account with no factor requires current-password step-up. Adding a factor to an already protected account additionally requires a fresh existing-factor proof.

Existing-factor proof is represented by a short-lived, single-use, purpose-bound step-up record. It binds user, operation, auth epoch, MFA epoch, and the initiating `session_id`. Passkey registration options and verification both require the same enrollment authorization.

Every successful factor addition, deletion, disablement, phone replacement, or recovery-code rotation advances `mfa_epoch` and durably revokes active refresh families. Active remote sessions are terminated after the durable commit; teardown failure is reported as partial operational failure but cannot restore token validity.

TOTP setup confirmation uses the consuming verifier, preventing the accepted time step from being replayed at login.

### Recovery codes

The login MFA schema gains an explicit recovery-code method. The endpoint accepts the documented `XXXX-XXXX` form, normalizes and peppers/hashes it using the existing helper, and atomically removes exactly one matching stored hash. Concurrent submissions have one winner. Tokens are minted only after both recovery-code and pending-MFA records are consumed. Use is audited without recording code material.

## SSO and OIDC

### Role delegation

SSO provider default-role configuration uses the same assignable-role and permission-subset validation as normal user administration. Validation runs when configuration is saved and again immediately before JIT provisioning. JIT remains limited to the provider's own partner/organization axis.

### Pending transaction lifecycle

SSO providers gain a monotonic configuration version. Pending SSO sessions store provider ID/version. Account-link sessions additionally store initiating user ID, auth epoch, and `session_id`. Callback processing reloads provider/user state and rejects inactive providers, version mismatch, auth-epoch mismatch, a revoked/expired initiating refresh family, tenant mismatch, or expired/consumed state.

Provider disablement/configuration changes increment the version and invalidate outstanding sessions. Logout invalidates link transactions through their bound refresh family; password reset, email change, status change, and global session revocation invalidate them through auth-epoch or family mismatch.

### Verified identity claims

Generic OIDC requires a positively verified email from a trusted claim source. Explicit `email_verified=false` is always rejected. Missing verification is rejected unless an explicit provider adapter documents and enforces an equivalent guarantee. Auto-linking remains passwordless-only and subject to verified-domain ownership.

### SSRF-safe discovery and JWKS

Discovery and JWKS retrieval share one SSRF-safe transport. It enforces HTTPS, allowed ports, redirect limits, response-size/time limits, DNS resolution checks, connection-time IP validation, and denial of loopback, link-local, private, metadata, and other non-public ranges. Persisted endpoints are revalidated at runtime. JWKS caching must not bypass transport validation on refresh.

## Email identity, recovery, and registration

### Pending email changes

Changing email no longer updates `users.email` immediately. After current-password and fresh-MFA step-up, the request stores a pending email and advances `email_epoch`. The current verified email remains the login/recovery address until the pending address is verified.

The verified email is also authoritative for identity-provider matching during the pending window: CF Access and SSO resolve users by `users.email`, and an IdP asserting the pending (unverified) address must not match. The "email changed" security notification to the old address fires when the pending change is initiated, not only on completion.

Verification artifacts bind user ID, exact normalized pending email, and email epoch. Successful verification atomically enforces global email uniqueness, swaps the address, clears pending state, stamps verification time, advances `auth_epoch` and `email_epoch`, and revokes active refresh families. Old verification and reset artifacts cannot validate a different current address.

Forced-enrollment exemptions permit only the operations needed to finish MFA enrollment; they do not permit recovery-email mutation.

### Password reset generations

Reset issuance advances `password_reset_epoch` and embeds the resulting value plus exact normalized current email in the single-use token record. Only the newest generation can succeed. Successful reset or ordinary password change advances both `password_reset_epoch` and `auth_epoch`, revokes all refresh families, and invalidates pending authentication/link transactions through epoch mismatch.

Forgot-password requests always return the same generic accepted response. The request enqueues an opaque job and does not await conditional database/email work. The worker resolves eligibility and sends only when allowed.

### Email-first partner registration

Partner registration becomes two-step:

1. Validate input and password strength, hash the password, create a short-lived pending-registration record in Redis under the SHA-256 hash of a token containing at least 256 random bits, queue a verification email, and always return the same generic accepted response. The payload contains normalized email, company/name, password hash, terms version/acceptance, hosted-mode expectation, creation time, **and the abuse-detection attribution captured from the live step-1 request (trusted client IP and user agent, per #2343)**; TTL is one hour. The request performs no user-existence lookup.
2. Verification atomically consumes the record, rechecks email uniqueness and hosted/self-hosted registration policy, creates the partner/user/organization/site, and only then issues the initial session. Partner creation passes the **step-1** attribution (signup IP/user agent from the pending record) into `createPartner`, never the verification-click request's IP/UA — the click often comes from a mail client or link scanner and would corrupt the abuse-signal sweep. The web signup UI switches from auto-login to a "check your email" state, and registration e2e/route tests are rewritten for the two-step contract.

No user, partner, token, slug, or account-existence detail is returned before verification. Redis unavailability returns the existing generic service-unavailable response and creates no record. Expired records disappear by TTL. Existing-email requests produce the same public response and equivalent asynchronous work without creating duplicate tenants; verification after possession of an already-registered address directs the owner to sign in without disclosing details to the original requester.

### Enumeration controls

Locked login accounts return the same generic floored response as unknown or invalid accounts; owner notification remains out-of-band. Registration, forgot-password, verification, and reset flows retain rate limits, but indistinguishable public behavior does not depend on those limits.

## API keys and service principals

Every existing key remains `human`-delegated. Authentication reloads the creator and rejects disabled/inactive users, missing current membership, tenant mismatch, or current permissions below the key's requested scopes. REST and MCP/AI paths use the same resolver.

The resolver **fails closed**: a null/absent permission resolution for the creator denies the request. The existing MCP path's behavior — `getUserPermissions` returning null leading to `allowedSiteIds = undefined`, which `siteAccessCheck` treats as unrestricted — is a fail-open bug that this PR fixes; no new code may reproduce it. The cheap subset of this finding (rejecting keys whose creator's `users.status` is not active) ships early in PR 1 alongside the other live-status checks; the full membership/permission-ceiling resolver and service principals ship here.

Introduce explicit service principals with:

- tenant ownership and active/disabled lifecycle;
- a human creator/last-updater retained for audit only;
- independently assigned, validated scopes/role ceiling;
- dedicated key issuance, rotation, expiry, and revocation;
- no interactive login, password, MFA, or recovery behavior.

API keys identify their principal type and principal ID. Human keys cannot be silently converted into service-principal keys. Existing automation owned by an offboarded user fails until an administrator creates and migrates it to an explicit service principal.

## Trusted client IP

Caddy strips untrusted forwarding headers and overwrites one internal canonical client-IP header from its trusted-proxy-aware client IP. The API accepts that header only from configured exact proxy CIDRs. Raw `CF-Connecting-IP` is accepted only in explicit Cloudflare mode with a trusted cloudflared/Cloudflare hop; generic mode never prefers it.

All naive direct-header readers migrate to the canonical resolver (`services/clientIp.ts`) in the same PR, or their values diverge/go null: `routes/auth/helpers.ts` `getClientIP` (login audit + failed-login attribution), `routes/portal/helpers.ts` `getClientIp`, `routes/sso.ts` `getClientIP`, `routes/tunnels.ts` `getClientIp`, `routes/installer.ts` and `routes/devices/provision.ts` raw `cf-connecting-ip` reads (enrollment-IP abuse attribution), `services/auditEvents.ts` forwarded-for snapshot, and `services/llm/openaiSessionManager.ts`. Compose/env defaults (`CADDY_TRUSTED_PROXIES`, `TRUST_PROXY_HEADERS`, `TRUSTED_PROXY_CIDRS`) are updated so hosted (Cloudflare) and self-hosted modes both derive a real client IP out of the box.

When a partner IP allowlist is configured but no trusted client IP can be derived, authorization fails closed. Shipped hosted and self-hosted Compose modes declare their trust mode explicitly.

## Failure handling and observability

- Security-state database failures fail the mutation; no success audit is emitted.
- Redis/cache cleanup failures emit bounded structured telemetry and retry without weakening durable revocation.
- Single-use artifact consumption fails closed on Redis/database ambiguity.
- Authentication errors remain generic publicly while server-side audit reasons remain specific.
- Audit events never contain raw JWTs, reset/verification tokens, MFA codes, WebAuthn assertions, API keys, or credential public-key material.
- Background email failures are observable and retryable without changing the public response shape.

## Delivery sequence

### PR 1: Authentication lifecycle foundation — SR2-01 through SR2-04, plus SR2-08 and the cheap half of SR2-15

Epoch schema/claims, forced legacy-token rejection (including the `/refresh` verifier), durable refresh-family revocation with MCP OAuth grant sweep, absolute family lifetime, live system/membership binding, and truthful logout failure semantics.

Pulled forward from later PRs on review: **SR2-08** (password-reset generation binding — `password_reset_epoch` schema already lands here and the finding is a confirmed HIGH/10 account takeover; do not leave it waiting behind the SSO PR) and the **disabled-creator API-key rejection** from SR2-15 (a few lines in `apiKeyAuth.ts`; the full resolver and service principals remain PR 5).

### PR 2: MFA policy and assurance — SR2-05, SR2-06, SR2-07, SR2-09, SR2-19, SR2-20, SR2-24

Effective policy resolver, epoch-bound pending MFA, factor-change invalidation, existing-factor passkey enrollment, working recovery codes, allowed-method enforcement, and TOTP-step consumption.

### PR 3: SSO/OIDC hardening — SR2-10 through SR2-14

Role-delegation checks, provider/session versions, initiator epoch binding, verified-email semantics, and SSRF-safe JWKS retrieval.

### PR 4: Email, recovery, registration, and enumeration — SR2-17, SR2-18, SR2-21 through SR2-23 (SR2-08 core moved to PR 1)

Pending-email workflow, recovery-email MFA step-up, email-first registration (with step-1 abuse attribution and web/e2e contract updates), asynchronous forgot-password, and generic lockout responses.

### PR 5: API-key principals — SR2-15

Live creator authorization plus explicit service-principal creation, authorization, rotation, disablement, and audit.

### PR 6: Trusted client-IP boundary — SR2-16

Canonical proxy header, explicit trust modes, fail-closed allowlists, and shipped configuration updates.

## Testing strategy

All behavior changes follow red-green-refactor TDD. Each regression test must be observed failing for the reviewed reason before production code is written.

### Unit and route tests

- JWT claim presence/mismatch, `sid`/family binding, legacy rejection, live system/membership checks, and token-mint coverage for every login/SSO/MFA/invite/bootstrap path.
- Logout and lifecycle behavior under database and Redis failures.
- Effective MFA policy inheritance, allowed methods, factor transitions, step-up purpose/expiry/replay, and recovery-code single use.
- SSO role ceilings, provider version/status, initiator epoch, verified-email combinations, discovery redirects, private IPs, DNS changes, and JWKS refresh.
- Pending email/reset/registration exact-address and generation checks, generic public responses, and non-awaited email work.
- Human and service-principal API-key status, permission, tenant, expiry, scope, and lifecycle checks.
- Trusted header acceptance/rejection for direct, Cloudflare, and generic proxy modes.

API tests cover unauthenticated, wrong role, wrong tenant, validation, not-found/conflict, server-error, empty/boundary, and multi-tenant cases using repository Vitest/Drizzle conventions.

### Integration and concurrency tests

- Real-Postgres tests prove mutation + epoch + family revocation atomicity and migration/RLS coverage.
- Concurrent refresh and logout tests prove revoked families cannot mint descendants.
- Concurrent recovery-code, reset-token, verification-token, SSO-session, and pending-registration consumption produces exactly one winner.
- Re-activation, membership replacement, factor replacement, and provider disablement do not revive old artifacts.

### Web and configuration tests

- Signup, email-change, forced-MFA, passkey-step-up, and recovery-code UI flows reflect the new server contract.
- Caddy/Compose static checks prove forwarded headers are overwritten and trust modes are explicit.
- Release notes call out global sign-out, email-first signup, pending-email confirmation, recovery-code availability, and delegated-key lifecycle changes.

### Verification gates

Every PR runs supported Node 22 build/typecheck, focused serial Vitest suites, database migration drift checks, relevant real-DB integration/RLS tests, and independent task/whole-PR review. After all six PRs, run a final cross-PR security review and the Breeze feature-testing workflow.

## Explicit product decisions

- Global sign-out on epoch rollout is approved. It signs out web **and mobile** (mobile stores the same HS256 JWTs in secure storage and re-authenticates through the normal login flow); release notes must name mobile explicitly. In-flight remote-desktop viewer tokens (separate audience, ≤2h TTL) survive the sign-out by design and expire on their own — documented, accepted.
- Any new Postgres table introduced by this work (step-up records, service principals, pending artifacts that land in the database) declares one of the six RLS tenancy shapes, adds policies in its creating migration, and registers in the rls-coverage contract-test allowlists in the same PR. Service principals declare their ownership axis explicitly (org-owned vs dual-axis) with justification per the partner-wide-first policy.
- Email-first registration creates no partner/user and issues no tokens before email verification.
- Existing API keys remain human-delegated and may stop working immediately when their creator is no longer authorized.
- Service principals are explicit and opt-in; no existing key is grandfathered as a service identity.
- Delivery uses six dependency-ordered PRs rather than one integration PR.

## Non-goals

- Rewriting the authentication subsystem or replacing JWT/Redis/PostgreSQL.
- Changing unrelated tenant authorization, agent enrollment, OAuth/MCP bearer design, or remote-access protocols.
- Preserving legacy JWT compatibility after the epoch rollout.
- Silently migrating human-owned keys into service principals.
