# MFA Client Completion Design

**Date:** 2026-08-28  
**Issues:** #2489, #3853, #3854  
**Scope:** API challenge negotiation, web MFA completion, and mobile MFA completion  
**Out of scope:** deployment, production flag changes, W07 Phase 2 compatibility removal, and unrelated W03-W06 follow-ups

## Objective

Complete the MFA client contract so the API, web client, and mobile client agree on which enrolled methods may be used for a login challenge. Users must be able to choose any server-authorized method, including a recovery code, without weakening the durable session authority delivered by W07 Phase 1.

## Constraints

- `AUTH_BROWSER_TRANSITIONS_ENABLED` and `AUTH_BROWSER_TRANSITIONS_ENFORCED` remain unchanged and disabled by default.
- The server is authoritative for method availability. Clients never infer that a method is permitted merely because they can render it.
- Existing clients that only understand `mfaMethod`, `passkeyAvailable`, and `phoneLast4` continue to work.
- Recovery codes remain a fallback credential, not an organization policy enrollment method.
- A challenge is bound to the user, auth epoch, MFA epoch, browser transition generation, and the server-authorized method set already captured in the pending record.
- Verification re-checks live policy and enrollment state; the method list returned at password completion is not durable authority.
- No production deployment or app-store action is part of this implementation.

## Approaches Considered

### 1. Extend the existing challenge response additively — selected

Keep `mfaMethod` as the preferred method and add an `allowedMethods` object plus `recoveryAvailable`. New clients use the richer contract; old clients continue using the existing fields. This minimizes rollout risk and preserves the current endpoint topology.

### 2. Replace the response with a method array

Return only `methods: MfaMethod[]` and force all clients to migrate together. This is cleaner but creates an unnecessary coordinated-release dependency and can strand older mobile builds.

### 3. Add a challenge-description endpoint

Return an opaque challenge from login and require clients to fetch its methods separately. This permits later refreshes but adds a network round trip and another pre-auth endpoint without solving a current requirement.

## API Contract

The MFA-required login response remains backward compatible and gains two fields:

```ts
type MfaMethod = 'totp' | 'sms' | 'passkey' | 'recovery';

interface MfaAllowedMethods {
  totp: boolean;
  sms: boolean;
  passkey: boolean;
}

interface MfaRequiredResponse {
  mfaRequired: true;
  tempToken: string;
  mfaMethod: 'totp' | 'sms';
  allowedMethods: MfaAllowedMethods;
  recoveryAvailable: boolean;
  passkeyAvailable: boolean;
  phoneLast4: string | null;
  user: null;
  tokens: null;
}
```

`allowedMethods` describes enrolled methods that the effective policy permits for this challenge:

- `totp` is true only when the account's enrolled TOTP method is allowed.
- `sms` is true only when the account's enrolled SMS method is allowed and a phone number is present.
- `passkey` is true only when a registered passkey exists and passkey MFA is permitted.
- `recoveryAvailable` is true only when at least one stored recovery-code hash exists. It is separate because recovery is not a policy enrollment method.

The response must expose at least one usable option. If policy and enrollment drift leave no usable primary, passkey, or recovery method, login fails closed with the existing generic authentication-error shape rather than issuing a challenge that cannot complete.

The pending MFA record stores the authoritative `allowedMethods` and `recoveryAvailable` snapshot. `/auth/mfa/verify` accepts `method: 'recovery'` only when the record permits recovery, and continues to consume exactly one valid code atomically. Passkey verification continues through its dedicated WebAuthn endpoints and must satisfy the pending record's passkey flag.

At verification time, the server re-checks live policy, factor ownership, epochs, and W07 transition authority. A method disabled after password verification fails without consuming the pending challenge or a recovery code unless the current security contract already requires terminal invalidation for that failure class.

## Web Client

The web client parses the additive fields with a backward-compatible adapter:

- When `allowedMethods` is present and valid, it is authoritative.
- Against an older server, the adapter exposes only the legacy `mfaMethod` and a passkey when `passkeyAvailable` is true; it does not guess recovery availability.
- A present but malformed or empty new method contract fails closed and shows a restart-sign-in action.

`MFAVerifyForm` renders a method selector only when more than one option is available. TOTP and SMS use a six-digit numeric input. Recovery uses a text input that preserves letters and separators while trimming surrounding whitespace. Passkey invokes the existing WebAuthn path.

Changing to SMS sends a code once for the selected challenge and retains the existing resend cooldown. Switching away from SMS does not invalidate the challenge. Errors stay attached to the selected method without exposing factor inventory before password verification.

Forced enrollment becomes policy-driven:

- The forced-enrollment page calls `GET /auth/mfa/enrollment-options` with its limited authenticated session. The response is `{ allowedMethods: { totp: boolean; sms: boolean; passkey: boolean }, phoneConfigured: boolean }`; it never includes recovery because recovery depends on a primary factor.
- TOTP reuses the current setup/enable flow.
- SMS reuses the existing phone verification/enrollment flow.
- Passkey reuses the current registration-grant/WebAuthn flow.
- Recovery is never offered as enrollment because it depends on a primary factor.
- If no enrollment method is available, the page fails closed and directs the user to an administrator instead of defaulting to TOTP.

Successful enrollment updates the authenticated user, preserves W07 generation-safe session handling, displays any newly generated recovery codes exactly once, and returns to the intended destination.

## Mobile Client

Mobile uses the same response adapter and method semantics as web. The challenge state stores `allowedMethods`, `recoveryAvailable`, `passkeyAvailable`, and `phoneLast4` with the existing temp token.

The MFA screen:

- displays a selector for every server-authorized method the mobile client supports;
- accepts six digits for TOTP/SMS and a trimmed, non-digit-only recovery string;
- sends SMS only after SMS is selected and retains the resend cooldown;
- verifies recovery through `/auth/mfa/verify` with `method: 'recovery'`;
- treats a server-authorized method unsupported by the installed client as unavailable and shows an upgrade/restart path if nothing supported remains.

All successful completions continue through `commitIfCurrent`. Logout, account switch, or a newer login generation prevents stale MFA responses from installing credentials, CSRF state, or native binding state.

Mobile forced enrollment is not added in this change because #3854 scopes login/session completion, while the existing API does not yet expose a native forced-enrollment navigation contract. A mobile login response that requires enrollment must remain fail-closed with an actionable web/admin handoff rather than silently granting normal app access.

## Error Handling and Security Properties

- Unknown method values, malformed method objects, and empty usable-method sets fail closed.
- Recovery input is never logged, included in telemetry, or retained after completion/cancellation.
- Recovery codes are consumed only inside the guarded session-finalization transaction.
- Selecting a method does not mint authority; all existing pending-token, rate-limit, epoch, RLS, and W07 capability checks remain in force.
- Client error copy does not distinguish nonexistent accounts or disclose factor inventory before a correct password.
- SMS send failures permit retry or selection of another authorized method without broadening the method set.
- Passkey cancellation returns to method selection without consuming the challenge.

## Testing

### API

- Contract tests for additive response fields and legacy fields.
- Allowed-method derivation for TOTP, SMS, passkey, recovery, mixed methods, and no-usable-method failure.
- Auth/authz and policy tests for `GET /auth/mfa/enrollment-options`, including limited forced-enrollment sessions and cross-tenant policy inheritance.
- Malformed/stale pending-record rejection.
- Live-policy disablement between password and verification.
- Recovery unavailable, invalid, identical-code race, distinct-code race, and no-consumption on failed W07 admission.
- Cross-user and cross-tenant pending-token rejection.

### Web

- Legacy-response fallback.
- Server-driven method rendering and empty/malformed fail-closed behavior.
- TOTP/SMS/recovery submission shapes and passkey dispatch.
- SMS selection/resend lifecycle.
- Recovery input formatting and clearing.
- Forced enrollment choices for TOTP/SMS/passkey and no-method failure.
- W07 428 retry and session-generation regression coverage.

### Mobile

- Challenge parsing and Redux storage of the method contract.
- TOTP/SMS/recovery input and request shapes.
- Unsupported-method and empty-method handling.
- SMS selection/resend lifecycle.
- Stale MFA completion after logout, account switch, or newer login generation.
- Credential and native-binding installation only for the current generation.

## Delivery Slices

1. Additive API challenge contract and server-side authorization tests.
2. Web login method selection and recovery-code completion.
3. Web policy-driven forced enrollment.
4. Mobile login method selection and recovery-code completion.
5. Consolidated auth/security review and focused API/web/mobile verification.

Each slice is independently reviewable. No slice changes production rollout flags or declares W07 Phase 2 complete.
