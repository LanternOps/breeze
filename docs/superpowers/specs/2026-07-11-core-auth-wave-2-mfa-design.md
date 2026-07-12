# Core Authentication Wave 2: MFA Policy and Assurance Design

**Findings:** SR2-05, SR2-06, SR2-07, SR2-09, SR2-19, SR2-20, SR2-24
**Depends on:** Wave 1 lifecycle foundation
**Parent design:** `docs/superpowers/specs/2026-07-11-core-authentication-hardening-design.md`

## Goal

Make MFA policy and assurance server-authoritative across login, refresh, request authorization, enrollment, factor replacement/removal, and account recovery.

## Effective policy

Add one resolver:

```ts
type MfaMethod = 'totp' | 'sms' | 'passkey' | 'recovery_code';

type EffectiveMfaPolicy = {
  required: boolean;
  allowedMethods: ReadonlySet<MfaMethod>;
  sources: Array<'role' | 'organization' | 'partner'>;
};

async function resolveEffectiveMfaPolicy(input: {
  userId: string;
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
  scope: 'system' | 'partner' | 'organization';
}): Promise<EffectiveMfaPolicy>;
```

The resolver combines role `forceMfa`, organization security settings, and partner security settings. `required` is true when any applicable source requires MFA. Allowed methods are the intersection of every explicitly configured applicable source; an empty intersection fails configuration validation rather than locking users out at runtime.

The canonical persisted setting is `security.allowedMethods`. The settings validator accepts the legacy spelling only as an input migration alias and emits/stores the canonical form. TOTP, SMS, passkey, recovery-code, login-option, and factor-use paths all consult the same resolver.

## Token assurance

Wave 2 adds an authentication-method claim to first-party tokens:

```ts
type AuthenticationMethod = 'password' | 'totp' | 'sms' | 'passkey' | 'recovery_code' | 'sso' | 'cf_access';

type TokenAssurance = {
  mfa: boolean;
  amr: AuthenticationMethod[];
};
```

Wave 2 advances every user's `mfa_epoch` during migration, intentionally invalidating Wave 1 sessions so tokens without trustworthy `amr` cannot survive rollout.

An unenrolled user under required policy never receives `mfa=true`. Middleware and refresh reload effective policy; required policy demands `mfa=true`, and a factor method in `amr` must remain allowed. SSO/Cloudflare Access may satisfy MFA only through their existing verified IdP-MFA signal rules.

## Pending MFA

Replace legacy string/partial JSON pending state with one versioned record:

```ts
type PendingMfaSession = {
  version: 2;
  userId: string;
  authEpoch: number;
  mfaEpoch: number;
  primaryMethod: 'totp' | 'sms' | 'passkey';
  passkeyAvailable: boolean;
  issuedAt: string;
};
```

TTL remains five minutes. Login writes only version 2. Completion atomically `GETDEL`s the pending record, reloads the active user and effective policy, compares epochs, verifies the selected allowed factor, then issues a new Wave 1 session. Database or factor failure requires a new password login; consumed pending records are never restored.

TOTP, SMS, passkey, and recovery-code completion use one shared post-verification session issuer and audit helper so status, epoch, policy, family, and login-audit behavior cannot drift.

## Existing-factor step-up

Initial factor enrollment with no active factor requires current password. Adding/replacing a factor when one already exists requires a fresh assertion from an existing allowed factor.

The assertion produces a single-use record:

```ts
type MfaStepUpPurpose = 'passkey.register' | 'totp.replace' | 'sms.replace' | 'email.change';

type MfaStepUpGrant = {
  version: 1;
  userId: string;
  sessionId: string;
  authEpoch: number;
  mfaEpoch: number;
  purpose: MfaStepUpPurpose;
  verifiedMethod: MfaMethod;
  issuedAt: string;
};
```

The raw grant token contains at least 256 random bits; Redis stores it under a SHA-256 hash for five minutes. The protected operation consumes the grant and requires matching user, `sid`, epochs, and purpose.

Passkey registration options and verification share a separate short-lived enrollment authorization derived from the consumed grant, preventing verify from being detached from the password/factor-approved options request.

## Factor mutations

Successful factor addition, replacement, deletion, MFA disablement, phone replacement, or recovery-code rotation runs in a database transaction that advances `mfa_epoch` and revokes all refresh families through Wave 1 primitives.

The current browser session is also invalidated. The API returns success with `reauthenticate: true`; web/mobile clients clear local state and redirect to login with a security-settings-changed notice. Forced enrollment completes by returning the user to login, where the new factor is exercised.

Remote sessions are terminated after the durable commit. Teardown failure is surfaced as partial operational failure but does not restore token validity.

TOTP enrollment confirmation uses `consumeMFAToken` with the user ID. The accepted time step cannot then satisfy login or another step-up.

## Recovery-code login

The MFA verify schema accepts an explicit `method: 'recovery_code'` with the documented `XXXX-XXXX` value. After pending-session consumption, a system-scoped database transaction locks the user row, hashes the normalized code with the existing pepper, removes exactly one matching stored hash, advances `mfa_epoch`, and revokes any existing families. It then issues a new session with `amr=['password','recovery_code']` and the new epoch.

Wrong, malformed, expired, and replayed codes return the same generic MFA failure. Two concurrent uses have one winner. Audit records method and remaining-code count but never code/hash material.

The login UI exposes “Use a recovery code,” accepts the documented format, and removes the misleading dead-end text once the working flow exists.

## Policy configuration

Organization and partner settings validate:

- at least one allowed method when MFA is required;
- only supported methods;
- SMS only when the deployment SMS provider is available, unless configuration is intentionally staged disabled;
- no organization setting can broaden a stricter partner policy.

Policy reads and writes return the canonical field. Existing `allowedMethods` data remains valid; the unreachable `allowedMfaMethods` read path is removed.

## Failure behavior

- Missing policy rows use documented defaults; database errors fail closed.
- Redis unavailable means pending MFA and step-up are unavailable, never bypassed.
- Epoch mismatch, inactive account, removed factor, or newly disallowed method invalidates pending state.
- Factor mutation rollback preserves both factor state and old epoch/families.
- Post-commit cache/remote cleanup failure is observable without weakening durable invalidation.

## Verification

Tests cover policy inheritance/intersection, organization-required enrollment, no vacuous `mfa=true`, AMR enforcement, every pending-MFA mismatch, passkey existing-factor proof, factor-change invalidation, current-session reauthentication, recovery-code happy/replay/concurrency behavior, canonical settings, and setup-code consumption.

Real-Postgres tests exercise row locking, concurrent recovery-code use, transaction rollback, epoch advancement, and family revocation. Web tests cover forced enrollment, factor changes, passkey step-up, and recovery-code login.
