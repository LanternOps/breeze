# Durable Browser Authentication Transition Design

**Status:** Approved implementation design

**Date:** 2026-07-12

**Fix-forward baseline:** `675f66ac2` (`fix(auth): make terminal logout server authoritative`)

## Purpose

Cloudflare Access logout must remain terminal even when another browser tab already has a login, registration, invite, MFA, recovery, refresh, or SSO request in flight. Browser-local Web Locks, localStorage markers, and response-only quarantine cookies cannot establish that ordering: an in-flight request sees the cookies captured when it began and may outlive the document that initiated logout.

This design replaces the response-cookie quarantine as the authority with one PostgreSQL-backed browser-auth transition. Every session issuer and Cloudflare logout preparation observes the same durable state. The existing commit is a fix-forward baseline; do not rewrite or amend it. Remove its quarantine behavior only after the durable transition is active and covered.

## Security properties

The implementation must provide all of these properties:

1. A logout that reaches the durable transition before an issuer's final transaction prevents that issuer from making any irreversible Breeze account, invite, MFA, recovery, identity-link, or session write.
2. An issuer final transaction that owns the transition first may commit, but logout waits, observes its newly linked family, and revokes it before logout preparation succeeds.
3. Ordering works across tabs, processes, API replicas, full-page navigation, unavailable Web Locks, and unavailable localStorage.
4. Authenticated, strict-CSRF Cloudflare preparation durably revokes bearer account A and the independently verified current refresh account B.
5. A stale, rotated, revoked, expired, malformed, or wrong-owner refresh token cannot select a user for global revocation.
6. The Cloudflare return is bound to an unpredictable, signed, short-lived, correlated, one-time ticket and works when no cookies are sent on a cross-site return.
7. Delayed requests carrying the pre-logout browser binding can never become admissible again after explicit completion.
8. Crashes and abandoned Cloudflare flows cannot permanently lock out the browser.
9. Redis remains a cache and coordination accelerator. PostgreSQL remains authoritative for browser-transition state, family state, refresh-currentness, and security epochs.

## Why the current quarantine is insufficient

At `675f66ac2`, preparation and the navigation endpoint set `breeze_cf_logout_quarantine`, and `setRefreshTokenCookie` rejects requests whose original `Cookie` header contains that value. This protects requests begun after the browser processes the response. It does not protect a request that was already in flight because that request's headers cannot observe a later `Set-Cookie`.

The existing GET completion endpoint also clears a boolean cookie without an unpredictable, correlated one-time return credential. Cookie presence alone cannot safely distinguish a genuine Cloudflare return from replay or direct navigation, and `SameSite=Strict` prevents reliance on the cookie being sent on the cross-site return.

## State model

### `auth_browser_transitions`

Add a system-only table with this logical shape:

```text
id                           uuid primary key
binding_digest               varchar(64) unique not null
generation                   bigint not null default 1
state                        active | logout_pending | retired
active_operation_id          uuid null
active_operation_expires_at  timestamptz null
current_user_id              uuid null references users(id)
current_family_id            uuid null references refresh_token_families(family_id)
logout_id                    uuid null
completion_nonce_digest      varchar(64) null
logout_expires_at            timestamptz null
retired_at                   timestamptz null
created_at                   timestamptz not null default now()
updated_at                   timestamptz not null default now()
```

Database checks enforce coherent states:

- `active` has no logout ID, nonce digest, expiry, or retired timestamp.
- `logout_pending` has a logout ID, nonce digest, and future expiry.
- `retired` has a retired timestamp and no active operation.
- Operation ID and operation expiry are both null or both non-null.

Index `logout_expires_at` for cleanup and `current_family_id` for diagnostics. The binding digest is an HMAC of the browser binding value using a domain-separated server key; never store the raw cookie value.

The table is security infrastructure that may correlate accounts used by one browser. It is not tenant-readable. Enable and force RLS in its creation migration and add a system-only policy. Record the table in the RLS coverage contract as the appropriate explicit system-only shape; do not leave it as an unscoped application table.

### Durable current refresh JTI

Add nullable `current_refresh_jti_digest varchar(64)` to `refresh_token_families`.

- Initial family creation stores the digest of the newly created refresh JTI in the same transaction.
- Rotation locks the family, requires the presented digest to equal the current digest, and updates it to the successor digest atomically.
- Redis JTI rotation markers may accelerate duplicate detection, but they do not decide whether a refresh cookie is current.
- A null value denotes a legacy family during rollout.

This field is required because the existing family row proves only that the family is active. It cannot distinguish the current refresh token from a rotated ancestor. Redis-only JTI state cannot participate atomically in the PostgreSQL logout transaction.

### SSO state and exchange grant

Add `browser_transition_id` and `browser_generation` to `sso_sessions`. The login-start route captures them before redirecting to the IdP, so the callback does not depend on a SameSite cookie to rediscover the transition.

Replace the process-local SSO exchange grant with a short-lived durable grant containing a hashed one-time code, transition ID/generation, user ID, family ID, expiry, and consumed timestamp. `/sso/exchange` consumes it under the same transition lock before setting a refresh cookie. This closes the current outlier where issuance occurs in the callback but cookie installation happens later outside the issuer boundary and outside the originating API process.

## Browser binding and CSRF lifecycle

The current `breeze_csrf_token` is a server-generated 256-bit random hex value, host-only, path `/`, and shared across tabs. It can be the minimal web binding, but not with its current lifecycle.

Required changes:

1. `setRefreshTokenCookie` preserves a valid existing CSRF cookie instead of rotating it on every successful issuer.
2. The transition service derives `binding_digest = HMAC(key, "auth-browser-binding:v1:" + csrfValue)`.
3. Cloudflare prepare requires an actual matching CSRF cookie/header and normal origin/Sec-Fetch-Site checks. The non-browser `x-breeze-csrf: 1` compatibility path is not valid for terminal preparation.
4. Preparation clears only the refresh cookie; it keeps binding C1 during the Cloudflare hops.
5. Successful completion retires C1 permanently and sets fresh CSRF/binding C2.
6. A missing binding, a retired binding, or an expired abandoned logout causes the issuer admission layer to issue C2 and return HTTP 428. The client retries the original issuer once with C2.
7. An old binding is never reopened. This is what rejects a delayed C1 request that reaches the database after logout completion.

The CSRF value is JavaScript-readable, but it grants no authority by itself. Terminal preparation still requires a verified, live bearer and strict double-submit validation. The HMAC prevents a database disclosure from revealing usable browser values. A future dedicated HttpOnly binding cookie may separate concerns, but is not necessary for this fix.

Native clients cannot silently bypass the transition by omitting cookies. They need an equivalent server-issued binding transported in a signed header and stored in SecureStore, or a verified cookie-jar implementation. The existing raw mobile device ID is identity metadata, not sufficient authority for a binding because it is client-selected. Until native transport is implemented, an issuer with neither a browser binding nor a valid native binding receives 428 and cannot mint a session.

## Issuer lease and capability

Long PostgreSQL transactions must not span password hashing, email, webhooks, IdP token exchange, or other network calls. Use a two-phase operation lease.

### Admission

`beginAuthIssuance(binding)` performs a short system transaction:

1. Upsert and lock the transition row.
2. Reject `logout_pending` and `retired` bindings.
3. Clear an expired operation lease; reject an unexpired competing operation with a retryable conflict.
4. Store a random operation ID and bounded expiry.
5. Return an opaque capability containing transition ID, generation, operation ID, and expiry.

Verification and external calls may follow admission, but no irreversible Breeze database or Redis consumption may occur yet.

### Finalization

`finishAuthIssuance(capability, callback)` starts a system transaction, locks the transition row, and verifies:

- state is still `active`;
- generation is unchanged;
- operation ID matches;
- lease has not expired.

The callback then performs all irreversible Breeze writes and session issuance in the same transaction. It atomically records the issued `current_user_id` and `current_family_id`, clears the operation, and commits. Post-commit work is limited to cache binding, audit delivery, email, and other effects that do not grant authority.

`issueUserSession` must require the guarded capability and the transaction. Remove its optional unguarded transaction/default path. The capability's constructor is private to the transition service, and `issueUserSession` performs a runtime transition assertion in addition to TypeScript enforcement.

If an operation crashes, its lease expires. A later admission may replace it. The expired capability can never finalize because finalization checks exact ID, generation, and expiry.

## Global lock ordering

Every involved transaction uses this order:

1. Browser transition row.
2. User rows, sorted by UUID.
3. Refresh-family rows, sorted by family UUID.
4. Route-specific rows such as invite, recovery-code, SSO session, and identity rows in stable key order.

No caller may acquire a user or family lock and then acquire a browser transition. Helper APIs should make the correct order the easy path and tests should force opposing request schedules to detect deadlocks.

## Cloudflare logout preparation

`POST /auth/cf-access-logout/prepare` remains assurance-exempt only after ordinary token signature, live authority/epoch, revocation, family, tenant, and CSRF validation.

Before its transaction, parse the bearer-A and refresh-B candidates. Inside one transaction:

1. Lock transition C1 first.
2. Set `logout_pending`, increment generation, record logout ID, nonce digest, and expiry, and invalidate any active operation.
3. Lock candidate users and families in canonical order.
4. Revalidate bearer A's durable family and live authority. If another revocation already won, terminal revocation is idempotent.
5. Classify refresh B:
   - current: signature/type/epochs valid, family live and owned by B, and JTI digest equals `current_refresh_jti_digest`;
   - legacy/stale: signed family may be revoked exactly, but B is not admitted as a global subject;
   - invalid: ignored for subject selection.
6. Revoke all durable families and advance the auth epoch for verified global subjects A and current B.
7. Revoke the transition's `current_family_id` exactly. This catches a new account C issued by a final transaction that obtained the transition immediately before logout.
8. Commit before Redis cutoff/family/JTI cache cleanup.

If any authoritative database step fails, roll back the pending state and return 503 with no completion ticket. Redis cleanup failure cannot reactivate a family or epoch; report it as partial cleanup and retry asynchronously.

The top-level GET route must not derive global revocation authority from a refresh cookie. A stale cookie may never name an account for global logout.

## Signed, correlated completion

Prepare generates a random 256-bit nonce, stores only its digest, and returns a URL containing a signed ticket with:

- version and audience;
- transition ID;
- logout ID;
- generation;
- nonce;
- issued-at and expiry.

Sign with HMAC using a domain-separated key derived from an existing required production secret. Verification uses timing-safe comparison. Do not log the ticket or nonce.

`GET /auth/cf-access-logout?ticket=...` verifies the ticket and pending row, then chains Cloudflare's application and team-domain logout endpoints. It propagates the same ticket in the configured-origin completion URL. A missing or invalid ticket does not globally revoke, retire, or unlock anything.

`GET /auth/cf-access-logout/complete?ticket=...` does not require cookies. It:

1. verifies signature, audience, expiry, IDs, generation, and nonce digest;
2. locks the transition;
3. consumes the nonce once;
4. retires C1;
5. creates active C2;
6. clears the refresh and C1 CSRF cookies and sets C2;
7. returns `303 /login?signedOut=1` with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

A replay after consumption may return the same signed-out redirect, but performs no mutation. An older ticket cannot complete or unlock a newer logout.

This works for SameSite Strict, Lax, and None because the ticket, not a cookie, correlates the cross-site return. Set-Cookie on the same-origin completion response installs C2 before the clean redirect.

## Issuer inventory and required restructuring

The code graph plus direct source audit identifies eight issuer groups:

| # | Issuer | Current production paths | Guarded irreversible work |
|---|---|---|---|
| 1 | `decideAuthenticatedUserSession` | password login and CF Access XHR middleware | direct family issue or binding-bearing pending-MFA creation |
| 2 | `issueVerifiedPendingMfaSession` | TOTP, SMS, passkey verification | one-time pending consumption, factor counter/migration, family issue |
| 3 | `completeRecoveryCodeLogin` | recovery-code MFA login | recovery hash consumption and family issue in one transaction |
| 4 | CF Access redirect login | `routes/auth/cfAccessRedirectLogin.ts` | last-login update and family issue |
| 5 | Partner registration | both initial and post-activation issuance in `register.ts` | partner/user creation, activation state, family issue |
| 6 | Invite acceptance | `invite.ts` | password/status/epoch update and family issue; Redis token deletion after commit |
| 7 | Refresh rotation | `login.ts` | current-JTI compare/swap and successor token issue |
| 8 | SSO callback | `routes/sso.ts` | JIT/link writes, encrypted IdP tokens, last login, family issue |

The SSO `/exchange` route is an additional cookie-writer outlier. It consumes a durable grant under the transition and rechecks the family before setting the cookie.

Specific requirements:

- Partner registration services must accept the outer guarded transaction. External hook/email work moves outside the authority-granting transaction.
- Invite activation, password change, epoch advance, family issue, and response state become one guarded transaction. Redis invite deletion follows commit.
- Recovery code consumption and issuance become one guarded transaction.
- Passkey counters, SMS one-time state, and TOTP secret migration cannot occur before admission; local irreversible database changes occur in finalization.
- SSO login-start records transition ID/generation. Callback claims state and applies identity/JIT/session writes under that transition. External IdP verification may use the operation lease but no Breeze identity write precedes finalization.
- Refresh rotation uses the durable family JTI compare-and-swap and the same browser transition.

## Failure and consistency model

- PostgreSQL failure: fail closed, no ticket, no successful issuer response.
- Redis unavailable: authoritative transactions still revoke/issue correctly; post-commit cache work is retried and logged without secrets.
- Completion unavailable: C1 stays pending until its TTL. The next issuer rotates to C2 via 428; C1 remains retired.
- CF redirect abandoned: same bounded recovery as completion unavailable.
- Operation abandoned: lease expires, replacement requires a new exact capability.
- Late issuer response: its family has been durably revoked if logout ordered after its finalization. A stale cookie may overwrite a clearing cookie by browser response order, but it cannot authenticate; the next refresh fails and clears it.
- Audit creation must record logout ID, transition ID, result, cleanup status, and counts, never binding values, tickets, JTI values, tokens, or CSRF values.

## Rollout

1. Add the transition table, nullable family JTI digest, SSO binding fields, and durable SSO grant table with idempotent migrations and RLS coverage.
2. Deploy dual-write code that creates transition rows, preserves CSRF bindings, and records current JTI digests for new/rotated families. Keep terminal enforcement behind a server flag until every API replica runs compatible issuer code.
3. Migrate all eight issuer groups and SSO exchange to the required capability. Typecheck and a source contract test must prove there is no unguarded `issueUserSession` call.
4. Enable durable preparation after all replicas enforce the guard.
5. During legacy rollout, an active family with null JTI digest may be revoked exactly but cannot select B for global revocation. Its next successful refresh upgrades the digest.
6. After the maximum family lifetime and fleet rollout, make `current_refresh_jti_digest` non-null in a later fix-forward migration.
7. Remove the boolean quarantine cookie and its helper only after the durable path is enabled and exact-diff security review passes.

## Validation requirements

The implementation plan must include deterministic integration barriers for both row-lock orders, every issuer group, cross-account bearer/refresh combinations, stale refresh classification, one-time ticket replay, cookie-less completion under all SameSite modes, abandoned operation/logout recovery, migration idempotence, drift, RLS coverage, API typecheck/lint/build, web/mobile tests, and an exact-diff security review.

No production push, merge, or destructive migration is part of this design.
