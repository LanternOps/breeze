# MFA Client Completion Design

**Date:** 2026-08-28
**Issues:** #2489, #3853, #3854
**Scope:** API challenge negotiation, web MFA completion, and mobile MFA completion
**Out of scope:** deployment, production flag changes, W07 Phase 2 compatibility removal, unrelated W03-W06 follow-ups, and the #3854 items that belong to W07 native transport — native-binding bootstrap/retry (`x-breeze-native-auth-binding`) and the mobile v1 transition header. Those are deferred to a W07-native follow-up and are not claimed by this spec; #3854 stays open after slice 4 until they land.

## Objective

Complete the MFA client contract so the API, web client, and mobile client agree on which enrolled methods may be used for a login challenge. Users must be able to choose any server-authorized method, including a recovery code, without weakening the durable session authority delivered by W07 Phase 1.

## Constraints

- `AUTH_BROWSER_TRANSITIONS_ENFORCED` (`apps/api/src/config/env.ts`) remains unchanged and disabled by default. There is no `AUTH_BROWSER_TRANSITIONS_ENABLED` flag: client opt-in is the per-request `x-breeze-auth-transition: v1` header (`routes/auth/helpers.ts`, `isAuthTransitionV1Request`), which the web client already sends.
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
  mfaMethod: 'totp' | 'sms' | 'passkey'; // today: user.mfaMethod || 'totp'
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
- `mfaMethod` keeps its current derivation (`user.mfaMethod || 'totp'`, `routes/auth/login.ts`) and may be `'passkey'` for a passkey-only account — legacy clients already handle that value. Legacy behavior is therefore deterministic: a legacy client sees exactly what it sees today (`mfaMethod` + `passkeyAvailable`), and a recovery-only challenge (primary factor disallowed, passkey absent, recovery codes present) is completable only by a new client. `mfaMethod` must always itself be an allowed option or, when the primary factor is disallowed by live policy, the response must still carry a usable `passkey`/`recovery` option — never a `mfaMethod` the record would reject.

The response must expose at least one usable option. If policy and enrollment drift leave no usable primary, passkey, or recovery method, login fails closed with the existing generic authentication-error shape rather than issuing a challenge that cannot complete.

The pending MFA record (`PendingMfaRecord`, `routes/auth/helpers.ts`, Redis `mfa:pending:<tempToken>`) already stores `allowedMethods: {totp, sms, passkey}`; this change adds `recoveryAvailable`. `parsePendingMfa` stays strict: a record missing or mistyping any `allowedMethods` boolean or `recoveryAvailable` is rejected (401), never defaulted permissively. Records written before deploy lack `recoveryAvailable` and are rejected for at most the 300 s pending TTL; that is accepted.

**Method-switch algorithm (normative).** Today `/auth/mfa/verify` ignores the client's `method` for TOTP/SMS and uses only `pending.mfaMethod` ("never allow the client to override"). This change replaces that with server-authorized selection:

1. Parse `method` strictly (`'totp' | 'sms' | 'recovery'`; unknown → 400). Default when absent: `pending.mfaMethod` (legacy clients).
2. `totp`/`sms`: require `pending.allowedMethods[method] === true` **and** that the account is actually enrolled in that factor (`mfaSecret` present for TOTP; `mfaMethod === 'sms'` with a phone number for SMS) **and** live `getEffectiveMfaPolicy(...).allowedMethods[method]`. Any failure → 401 with the existing generic error; audit `mfa_method_not_allowed`.
3. `recovery`: require `pending.recoveryAvailable === true`; the hash check and relative jsonb delete stay inside the guarded finalization exactly as today (`consumeRecoveryCode`).
4. Passkey verification stays on its dedicated WebAuthn routes (`routes/auth/passkeys.ts`) and must additionally require `pending.allowedMethods.passkey === true`.

`POST /auth/mfa/send-sms` (and any other pending-token continuation, including passkey challenge issuance) must independently authorize the pending token, the selected method against the pending record and live policy, epochs/status expectation, and the existing challenge-keyed rate limit. Selecting a method mints no authority.

At verification time, the server re-checks live policy, factor ownership, epochs, and W07 transition authority. Current behavior is normative and unchanged by this spec:

- A method disallowed by live policy after password verification is **terminal**: the pending record is deleted (`redis.del`, `routes/auth/mfa.ts`) and the user must sign in again. It is not a soft failure that returns to method selection, because a client could otherwise probe policy state against a live challenge.
- Under the W07 v1 header path, a recovery code is consumed only inside `finishAuthIssuance`, so a logout-pending transition never burns a code.
- On the legacy (non-v1) path the recovery code is consumed in its own transaction **before** session issuance, as today. This spec does not change that; it is retired with the legacy path in W07 Phase 2.
- Wrong code, unavailable method, and stale-record failures do not delete the pending record beyond what the existing rate limiter and epoch checks already do.

## Web Client

The web client parses the additive fields with a backward-compatible adapter:

- When `allowedMethods` is present and valid, it is authoritative.
- Against an older server, the adapter exposes only the legacy `mfaMethod` and a passkey when `passkeyAvailable` is true; it does not guess recovery availability.
- A present but malformed or empty new method contract fails closed and shows a restart-sign-in action.

`MFAVerifyForm` renders a method selector only when more than one option is available. TOTP and SMS use a six-digit numeric input. Recovery uses a text input that preserves letters and separators while trimming surrounding whitespace. Passkey invokes the existing WebAuthn path.

Changing to SMS sends a code once for the selected challenge and retains the existing resend cooldown. Switching away from SMS does not invalidate the challenge. Errors stay attached to the selected method without exposing factor inventory before password verification.

Forced enrollment becomes policy-driven:

- Forced enrollment is not a limited session: login mints a full session and `middleware/auth.ts` returns `428 mfa_enrollment_required` on every route outside `isMfaEnrollmentExemptPath`. The forced-enrollment page calls the new `GET /auth/mfa/enrollment-options` (authenticated). Because `/auth/mfa/*`, `/auth/phone/*`, and `/auth/passkeys/*` are already exempt, no middleware change is needed — the implementation must add a test asserting the new route is reachable in the 428-gated state. The response is `{ allowedMethods: { totp: boolean; sms: boolean; passkey: boolean }, phoneConfigured: boolean }`, derived from `getEffectiveMfaPolicy` for the caller's resolved scope/org/partner; it never includes recovery because recovery depends on a primary factor.
- `getEffectiveMfaPolicy` currently hardcodes `passkey: true` (`services/mfaPolicy.ts`, phishing-resistant factor is always permitted), so the "no method available" server case is unreachable today. The fail-closed rule stays as defense in depth for a future policy that can restrict passkeys.
- TOTP reuses the current setup/enable flow.
- SMS reuses the existing phone verification/enrollment flow.
- Passkey reuses the current registration-grant/WebAuthn flow.
- Recovery is never offered as enrollment because it depends on a primary factor.
- If no enrollment method is available, the page fails closed and directs the user to an administrator instead of defaulting to TOTP.

Enrolling **any one** permitted method satisfies the policy requirement. Completion is atomic per factor: the terminal enable/verify endpoint for that factor (TOTP enable, SMS enable after phone verification, passkey registration finish) sets the account enrolled, generates recovery codes once, advances `mfa_epoch`, revokes the pre-enrollment refresh family, and issues its replacement MFA-assured W07 session in the same database transaction. The endpoint returns the replacement access-token metadata and installs the replacement refresh/CSRF cookies; the client must install that replacement before leaving the enrollment page. A partial or abandoned enrollment (setup started, never enabled) leaves the user in the 428-gated state with no factor recorded; no half-enrolled factor is ever persisted as enabled.

The post-enrollment replacement is not implemented through `/auth/refresh`: `invalidateMfaAssuranceAfterFactorChange` revokes every existing refresh family, including the pre-enrollment family, so that path cannot authorize a replacement. The enrollment routes instead use the W07 issuance capability and `issueUserSession` inside the terminal factor-change transaction. If issuance cannot complete, the factor write and recovery-code write roll back with it; the response never reports enrollment success without a usable replacement session.

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

Mobile forced enrollment UI is not added in this change because #3854 scopes login/session completion, while the existing API does not yet expose a native forced-enrollment navigation contract. **Today mobile ignores `mfaEnrollmentRequired` entirely** and installs a session that then 428s on every gated route. Slice 4 must add explicit handling: when the login response carries `mfaEnrollmentRequired: true`, mobile does not install the credentials as a normal session and instead shows a fail-closed screen with an actionable web/admin handoff. This is new behavior, not preservation of existing behavior.

`commitIfCurrent` semantics are normative: logout and account switch advance the session generation **before** clearing local state, and installation of tokens, CSRF state, account identity, and the native binding is a single current-generation commit — never partial.

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
- Live-policy disablement between password and verification (terminal: pending record deleted).
- Method-switch matrix: requested method not in pending `allowedMethods`, allowed-but-not-enrolled, allowed-and-enrolled; strict rejection of records missing `recoveryAvailable`.
- `send-sms` with SMS not in pending `allowedMethods`.
- Recovery unavailable, invalid, identical-code race, distinct-code race, and no-consumption on failed W07 admission.
- Cross-user and cross-tenant pending-token rejection.

### Web

- Legacy-response fallback.
- Server-driven method rendering and empty/malformed fail-closed behavior.
- TOTP/SMS/recovery submission shapes and passkey dispatch.
- SMS selection/resend lifecycle.
- Recovery input formatting and clearing.
- Forced enrollment choices for TOTP/SMS/passkey and no-method failure.
- Atomic factor write, recovery-code persistence, refresh-family revocation, and replacement-session issuance for TOTP/SMS/passkey enrollment.
- W07 428 retry and session-generation regression coverage.

### Mobile

- Challenge parsing and Redux storage of the method contract.
- TOTP/SMS/recovery input and request shapes.
- Unsupported-method and empty-method handling.
- SMS selection/resend lifecycle.
- Stale MFA completion after logout, account switch, or newer login generation.
- `mfaEnrollmentRequired` login response does not install a normal session.
- Credential and native-binding installation only for the current generation.

## Delivery Slices

1. Additive API challenge contract and server-side authorization tests.
2. Web login method selection and recovery-code completion.
3. Web policy-driven forced enrollment.
4. Mobile login method selection and recovery-code completion.
5. Consolidated auth/security review and focused API/web/mobile verification.

Each slice is independently reviewable. No slice changes production rollout flags or declares W07 Phase 2 complete.
