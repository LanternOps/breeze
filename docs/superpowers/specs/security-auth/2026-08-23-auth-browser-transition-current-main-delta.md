# Durable Browser Authentication Transition — Current-Main Delta

**Status:** Approved delta to the 2026-07-12 design

**Date:** 2026-08-23

**Baseline:** `origin/main` at `dfe02c5e6`

**Preserved design:** `docs/superpowers/specs/2026-07-12-auth-browser-transition-design.md` on the preserved `fix/core-mfa-policy-assurance` branch

## Problem

The approved 2026-07-12 design remains the normative security design: PostgreSQL must linearize browser and native logout against every authority-granting session issuer. Redis, browser Web Locks, localStorage, response ordering, and process-local maps cannot provide that ordering across tabs or API replicas.

Current `main` still has the underlying race. Session issuance is distributed across nine `createTokenPair` call sites and nine refresh-cookie writers. Refresh-token currentness is claimed in Redis rather than atomically in the family row, Cloudflare logout derives revocation authority from a refresh cookie on an unauthenticated GET, and SSO exchange grants live in a process-local `Map`.

This document changes the July design only where current `main` or the decisions below supersede it. All other security properties, failure semantics, lock ordering, capability rules, ticket rules, tombstone rules, and rollout constraints from the July design remain required.

## Current-main changes

The implementation must extend current `main`; it must not copy the preserved staging branch wholesale.

- Security epochs and durable family expiry are already canonical in `2026-07-15-auth-epochs-and-family-expiry.sql`, `services/authLifecycle.ts`, `services/authEpochs.ts`, `middleware/auth.ts`, and `/auth/refresh`. The old `2026-07-11-a-auth-security-epochs.sql` must not be reused.
- MFA policy, pending-session epoch checks, recovery-code concurrency, and factor invalidation are canonical in `services/mfaAssurance.ts`, `routes/auth/mfa.ts`, and `routes/auth/passkeys.ts`. W07 wraps irreversible effects in the transition finalizer; it does not replace those implementations.
- SSO now has provider configuration generations, initiating-session epoch binding, forced system-only RLS on `sso_sessions`, delegation-ceiling checks, verified-domain controls, rate limiting, and hardened OIDC fetching. W07 adds browser-generation binding and a durable exchange to this implementation.
- Hosted registration is email-first. `routes/auth/register.ts` creates no account or login session. The authority-granting registration issuer is `routes/auth/verifyEmail.ts` and must be guarded there.
- Auth-cookie transport now derives `Secure` from the trusted request transport and emits misconfiguration diagnostics. W07 must preserve `isRequestConnectionSecure` and the current cookie-builder signatures.
- Trusted client-IP resolution and Cloudflare redirect origin validation already exist and remain authoritative.
- The production issuer inventory is:
  - `apps/api/src/middleware/cfAccessLogin.ts`
  - `apps/api/src/routes/auth/cfAccessRedirectLogin.ts`
  - `apps/api/src/routes/auth/invite.ts`
  - `apps/api/src/routes/auth/login.ts` (password login and refresh rotation)
  - `apps/api/src/routes/auth/mfa.ts`
  - `apps/api/src/routes/auth/passkeys.ts`
  - `apps/api/src/routes/auth/verifyEmail.ts`
  - `apps/api/src/routes/sso.ts`
  - `/sso/exchange` is the additional refresh-cookie installation boundary.

## Approved decisions

1. **Ordinary and Cloudflare logout are terminal.** `POST /auth/logout` and the Cloudflare prepare/completion flow lock the same transition row as every issuer. Ordinary logout retires the current binding and installs its successor in the same response. Cloudflare logout remains pending until the signed cross-site completion consumes its nonce.
2. **Use a dedicated HttpOnly browser-binding cookie.** Add `breeze_auth_binding`, host-only, path `/`, HttpOnly, with the same trusted-transport `Secure` and configured `SameSite` decisions as the refresh cookie. Do not reuse or stabilize `breeze_csrf_token`; CSRF remains an independent double-submit control.
3. **Native binding ships in W07.** A server-signed `x-breeze-native-auth-binding` value is persisted in SecureStore and fenced by the mobile session generation. `x-breeze-mobile-device-id` remains metadata and never grants binding authority.
4. **Bootstrap before full-page SSO.** Web login performs a same-origin `POST /auth/browser-binding/bootstrap` before navigating to `/sso/login/...` or the Cloudflare redirect-login endpoint. SSO initiation fails closed if no valid binding reaches it.
5. **Durable-prepare failure fails closed.** The client clears local authority but does not navigate to a bare Cloudflare logout GET. It shows a signed-out/retry state; the server emits no ticket or authority-bearing redirect when the PostgreSQL transaction fails.
6. **Remove the obsolete SSO refresh-token compatibility response.** Delete `SSO_EXCHANGE_RETURN_REFRESH_TOKEN` from the SSO route/tests and active operator/security documentation, together with the JSON `refreshToken` response branch. Current `main` has no typed config or `.env.example` declaration for this direct `envFlag` compatibility path. `/sso/exchange` installs refresh authority only through the HttpOnly cookie.

## Tenancy and data model

### `auth_browser_transitions`

System-only security infrastructure keyed by an HMAC digest of the dedicated browser or native binding. It retains the July fields and constraints: generation, state, bounded active-operation lease, current user/family pair, logout ID, completion nonce digest, expiry, retirement timestamp, and key provenance. Raw binding values are never stored.

The current-family ownership relation must use a composite foreign key `(current_family_id, current_user_id) -> refresh_token_families(family_id, user_id)`. Add the corresponding unique key to refresh families idempotently.

### Refresh families

Add nullable `current_refresh_jti_digest varchar(64)` for the staged rollout. Initial issuance writes it with the family insert. Rotation locks the family and atomically compares the presented digest with the current digest before storing the successor digest. A null legacy value permits exact-family revocation but cannot select a user for global logout.

### SSO state and exchange

Add nullable `browser_transition_id` and `browser_generation` to `sso_sessions` without disturbing its existing provider-version and initiating-session fields. Login initiation writes both binding dimensions. Callback state is claimed under that stored transition generation.

Add `sso_token_exchange_grants` containing only the exchange-code digest, transition/generation, user/family, expiry, and consumed timestamp. Token material is authenticated encryption inside the unpredictable client-carried exchange code, not plaintext database data. Consumption locks transition, user, family, then grant.

### RLS

`auth_browser_transitions` and `sso_token_exchange_grants` have RLS enabled and forced with exactly one system-scope-only `ALL` policy. Register both in `INTENTIONAL_UNSCOPED` in `rls-coverage.integration.test.ts`, and add direct `breeze_app` forge tests proving tenant SELECT sees zero rows, UPDATE affects zero rows, INSERT fails `WITH CHECK`, and system context succeeds. These tables intentionally expose no tenant-readable browser-to-account correlation.

## Out of scope

- The W03 OIDC port-policy and partner-axis verified-domain follow-ups.
- W04 email-change settings UI and verification auto-login UI coverage except where `verifyEmail.ts` session issuance must be guarded.
- W05 service-principal UI and MCP/AI per-tool principal work.
- W06 partner-allowlist and client-IP source-mode follow-ups.
- Full web MFA settings UI (W08) and unrelated mobile authentication UX (W09).
- Making `current_refresh_jti_digest` `NOT NULL`; that is a later fix-forward migration after the maximum family lifetime and fleet rollout.
- Deleting retired binding tombstones without a fleet-authoritative signing-key retirement protocol.
- Production deployment or enabling the enforcement flag.

## Open decisions

None. The scope and security/product decisions required for planning are approved above.

## Test and rollout

- Each implementation slice is independently deploy-safe with terminal preparation and enforcement disabled.
- Freeze the exact issuer and cookie-writer inventory before production changes. A new unreviewed caller fails CI.
- Use deterministic real-PostgreSQL barriers, not timing sleeps, to prove both transition/issuer lock orders and refresh compare-and-swap concurrency.
- Test ordinary logout, Cloudflare prepare/completion, stale/current/cross-account refresh classification, ticket replay, cookie-less completion, abandoned lease/logout recovery, SSO callback/exchange across replicas, native bootstrap/retry, and delayed old-binding responses.
- Run forced-RLS forge tests, migration idempotence, `pnpm db:check-drift`, API/web/mobile focused suites, Chromium browser contracts, typecheck, lint, and build.
- Roll out additively: schema first; binding bootstrap and current-JTI dual-write; migrate every issuer; ship SSO/native clients while the frozen legacy seam remains available with enforcement false; then observe zero supported-client legacy issuance for a full configured maximum refresh-family lifetime. Only after that gate may the seam be deleted, the final guarded API build reach every replica, and enforcement then terminal preparation be enabled. Older native clients become an explicit unsupported-version/426 upgrade case, never a fallback after enforcement.
- Legacy families with null current-JTI are never global-subject authority. Their next successful guarded refresh upgrades them.
- Do not reuse or edit the preserved branch migrations. The implementation starts with `apps/api/migrations/2026-08-23-z-auth-browser-transitions.sql`, which sorts after the existing 2026-08-23 migrations.
