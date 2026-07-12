# Core Authentication Wave 4: Identity Recovery and Registration Design

**Findings:** SR2-08, SR2-17, SR2-18, SR2-21, SR2-22, SR2-23
**Depends on:** Wave 1 epochs/session revocation; Wave 2 fresh MFA step-up
**Parent design:** `docs/superpowers/specs/2026-07-11-core-authentication-hardening-design.md`

## Goal

Bind email and password-recovery artifacts to exact identity generations, require strong step-up for recovery-address changes, make partner signup email-first, and remove public account-enumeration signals.

## Pending email workflow

Wave 1 adds `users.pending_email` and `users.pending_email_requested_at`. `users.email` and `email_verified_at` remain unchanged until verification completes.

Requesting an email change requires:

- an authenticated active user;
- current password for password-capable accounts;
- a Wave 2 fresh-MFA step-up grant when any factor exists or policy requires MFA;
- normalized email validation and a preliminary uniqueness check.

The transaction advances `email_epoch`, writes the new pending email/timestamp, and invalidates prior pending-email artifacts. The response does not change the authenticated identity.

The verification record contains user ID, exact normalized pending email, and email epoch. Successful verification atomically rechecks uniqueness and record binding, swaps `email`, clears pending state, stamps `email_verified_at`, advances `auth_epoch` and `email_epoch`, and revokes all refresh families. Old-address notification is queued after commit.

Cancelling/replacing a pending email advances `email_epoch`. Forced-MFA enrollment exemptions do not permit email mutation.

## Password reset generations

The forgot-password worker issues reset records containing:

```ts
type PasswordResetRecord = {
  version: 2;
  userId: string;
  normalizedEmail: string;
  passwordResetEpoch: number;
  emailEpoch: number;
  issuedAt: string;
};
```

Issuance atomically advances `password_reset_epoch`; only the newest request can succeed. Records remain keyed by SHA-256 token hash with a one-hour TTL.

Reset completion atomically consumes the record, reloads user/email epochs, enforces eligibility, changes the password, advances `password_reset_epoch` and `auth_epoch`, and revokes all refresh families. Ordinary password change performs the same epoch/family operations. Email commitment invalidates old reset records through email mismatch/epoch even before their TTL ends.

## Authentication email jobs

Add a dedicated BullMQ authentication-email queue with bounded attempts/backoff and typed jobs:

```ts
type AuthEmailJob =
  | { type: 'password-reset-request'; requestId: string }
  | { type: 'partner-registration-verification'; requestId: string }
  | { type: 'pending-email-verification'; requestId: string }
  | { type: 'email-changed-notice'; requestId: string };
```

Public forgot-password and registration handlers validate/rate-limit, store a short-TTL Redis envelope containing the sensitive/PII payload, enqueue only the opaque request ID, and immediately return the same generic 202 response. They never await conditional account lookup or provider I/O. Workers claim the envelope, perform eligibility/existence checks under system context, and send only when appropriate.

Job logs/audits use request IDs and outcomes, never raw tokens or passwords. Exhausted jobs reach existing worker observability/dead-letter handling.

## Email-first partner registration

`POST /auth/register-partner` performs no user-existence lookup and issues no credentials. It validates input/terms/password, hashes the password, creates a Redis pending record under a SHA-256 hash of a token with at least 256 random bits, enqueues verification email, and returns the generic 202 body.

The pending record has one-hour TTL and contains normalized email, admin/company name, password hash, accepted terms version/time, hosted-mode expectation, and creation time. Redis/queue unavailability returns generic 503 and stores no partial registration.

Verification uses atomic `GETDEL`, then rechecks current registration configuration and global email uniqueness. For a new email it calls existing atomic partner creation, dispatches registration hooks, and issues the first Wave 1 session only after the account exists. For an existing email it creates no tenant and returns a generic owner-facing sign-in outcome. The original unauthenticated requester cannot distinguish these paths.

The web registration page changes from auto-login to “check your email.” The verification page handles success, expired/replayed link, existing-account sign-in guidance, and resend by restarting the registration form without exposing account existence.

## Login lockout response

The global account lock remains enforced and owner notification remains out-of-band. A locked account returns the same generic 401 body and response floor as unknown user, passwordless user, invalid password, inactive account, and SSO-required denial. Public responses do not include `account_locked` wording or an account-specific retry interval.

Rate-limit 429 responses remain rate-limit-specific but are derived from public IP/input buckets that exist for every normalized email, not the internal real-account lock state.

## Step-up and session behavior

Email change consumes a purpose-bound Wave 2 `email.change` grant. Password reset is possession-based and does not require an existing session. Successful email or password changes invalidate all existing sessions through Wave 1.

The web app treats successful security mutation as signed out, clears local access state, and shows a “Security information changed—sign in again” notice.

## Failure behavior

- Redis/queue failure cannot create a partner or claim a changed email.
- Consumed verification/reset/registration artifacts are not restored after downstream failure; users restart the request, preventing ambiguous replay.
- Database transaction failure preserves the old verified email/password and epochs.
- Duplicate-email races have one winner through the existing unique constraint and transaction conflict handling.
- Email-provider latency/failure is isolated in workers and cannot change the public response timing/shape.

## Verification

Tests cover sibling reset-token supersession, ordinary password-change invalidation, reset after email change, pending-email exact binding, old verification-token rejection, fresh-MFA requirement, forced-enrollment field restriction, duplicate-email races, pending-registration expiry/replay, no pre-verification tokens, queue failure, and generic public response parity.

Worker tests assert eligible/ineligible/unknown paths, retries, and redacted logs. Web tests cover check-email registration, verification outcomes, pending email, signed-out mutation completion, generic forgot-password, and recovery flows. Real-Postgres tests cover epoch transactions and concurrent uniqueness/consumption.
