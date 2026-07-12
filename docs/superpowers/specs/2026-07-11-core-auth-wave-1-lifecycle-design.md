# Core Authentication Wave 1: Lifecycle Foundation Design

**Findings:** SR2-01, SR2-02, SR2-03, SR2-04
**Depends on:** none
**Parent design:** `docs/superpowers/specs/2026-07-11-core-authentication-hardening-design.md`

## Goal

Make PostgreSQL the durable authority for user-session validity so user reactivation, privilege or membership changes, logout, and Redis failure cannot revive or preserve stale first-party credentials.

## Scope

This wave adds the epoch/session schema used by later waves, migrates every first-party JWT mint path, enforces live system/tenant authority before RLS context, introduces durable family revocation, and changes logout to report its actual revocation result.

It intentionally invalidates every pre-deployment access and refresh token. The deployment requires a global sign-in event; no claimless compatibility path exists.

## Data model

Add non-null integer columns with default `1` to `users`:

- `auth_epoch`
- `mfa_epoch`
- `email_epoch`
- `password_reset_epoch`

Only `auth_epoch` participates in Wave 1 lifecycle mutations. The other columns land in the same idempotent migration so later waves use one stable token/schema contract.

Add `absolute_expires_at timestamptz NOT NULL` to `refresh_token_families`. Backfill existing rows to `created_at + interval '30 days'`; those rows remain unusable after deployment because their JWTs lack required epoch/session claims. New families use one configuration constant for the fixed absolute lifetime.

The migration does not create a new tenant table, does not alter RLS policy shape, and must pass schema drift plus the RLS coverage contract.

## Token contract

First-party access and refresh JWTs require:

- `ae`: current `users.auth_epoch`
- `me`: current `users.mfa_epoch`
- access `sid`: refresh-family UUID
- refresh `fam`: the same refresh-family UUID

Legacy tokens missing `ae`, `me`, or their session/family claim are invalid.

Create a high-level session issuer that replaces route-level repetition of `mintRefreshTokenFamily`, `createTokenPair`, and `bindRefreshJtiToFamily`:

```ts
type UserSessionIdentity = {
  userId: string;
  email: string;
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
  scope: 'system' | 'partner' | 'organization';
  mfa: boolean;
  mobileDeviceId?: string;
};

type IssueUserSessionOptions = {
  familyId?: string;
};

async function issueUserSession(
  identity: UserSessionIdentity,
  options?: IssueUserSessionOptions,
): Promise<TokenPair & { familyId: string }>;
```

The issuer reloads current epochs, creates or validates the family, refuses an expired/revoked family, signs both tokens with matching epoch/session claims, and binds the refresh JTI. Callers cannot provide epoch values.

The refresh route rotates within the existing family only when `absolute_expires_at > now()`, the family is not durably revoked, and token epochs equal the live user row.

Every first-party issuer migrates in this wave: password login/refresh, TOTP/SMS MFA completion, passkey completion, SSO, invite acceptance, partner registration, Cloudflare Access login, and Cloudflare Access redirect login.

## Durable lifecycle service

Add transaction-scoped primitives:

```ts
type SecurityEpochAdvance = {
  auth?: boolean;
  mfa?: boolean;
  email?: boolean;
  passwordReset?: boolean;
};

async function advanceUserSecurityState(
  tx: DbTransaction,
  userId: string,
  advance: SecurityEpochAdvance,
  reason: string,
): Promise<{ authEpoch: number; mfaEpoch: number; emailEpoch: number; passwordResetEpoch: number }>;

async function revokeAllUserSessionFamilies(
  tx: DbTransaction,
  userId: string,
  reason: string,
): Promise<number>;

async function revokeUserSessionFamily(
  tx: DbTransaction,
  userId: string,
  familyId: string,
  reason: string,
): Promise<boolean>;
```

Status transitions out of `active`, membership removal, and future privilege-demotion mutations advance `auth_epoch` and revoke all active families in the same transaction as the business mutation. A failure rolls back both business state and security state.

Redis cutoff, JTI, family-cache, OAuth-artifact, permission-cache, and remote-session cleanup runs after commit. Failure is observable and retryable but does not affect durable invalidation.

## Request authorization

`authMiddleware` verifies the signed token and loads the live user row before any RLS context. It rejects:

- missing/invalid epoch or session claims;
- `ae` or `me` different from the live row;
- inactive/missing user;
- system scope when `is_platform_admin` is not currently true;
- organization scope without a matching live `organization_users` row;
- partner scope without a matching live `partner_users` row;
- inactive tenant context.

Accessible organization/site calculations remain downstream of these authority checks. This makes out-of-band database demotion or membership deletion fail closed even if no application hook advanced the epoch.

## Logout

Access tokens carry `sid`, so logout can identify the session even when no refresh cookie is present. When both are present they must name the same family.

Logout behavior:

1. authenticate access token and resolve `sid`;
2. verify any refresh-cookie `fam` matches;
3. durably revoke that family in PostgreSQL;
4. clear the local refresh cookie regardless of outcome;
5. perform Redis/JTI cleanup after the database commit;
6. audit success only after durable revocation; otherwise audit failure and return 503.

Logout revokes the current session, not every session for the user. Account-security mutations use the all-family operation.

## Failure behavior

- Database unavailability fails token issuance, refresh, logout, and lifecycle mutation closed.
- Redis unavailability continues to fail closed on existing rate-limit/MFA paths, but cannot revive a family marked revoked in PostgreSQL.
- Post-commit cache cleanup failure emits structured error telemetry with user/family/reason identifiers but no token material.
- Concurrent refresh/logout has one winner: the durable family-revoked check prevents descendants after logout commits.

## Verification

Unit and route tests cover required claims, every issuer, epoch mismatch, live authority, Redis failure, truthful logout audits, and absolute expiry. Real-Postgres integration tests cover migration defaults, atomic status/membership mutation plus revocation, reactivation non-revival, logout/refresh races, and RLS coverage.

Release notes explicitly announce global sign-out and the new fixed refresh-family lifetime.
