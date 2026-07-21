# Authenticator approver-device registration — grant-based re-auth

**Issue:** #2707
**Date:** 2026-07-21
**Status:** Design approved, pending implementation plan

## Problem

Approver-device registration for the Breeze Authenticator returns **HTTP 400 on
both the mobile app and the browser client** because neither client sends the
`currentPassword` step-up the server requires (`routes/authenticator.ts`
`registerOptionsSchema` / `mobileRegisterSchema`). Consequences:

- Partners with `authenticator_policies.require_enrollment = true`: any approval
  whose risk tier requires ≥L2 throws `StepUpRequiredError` → **403, approval
  hard-blocked** (a real outage).
- Everyone else: a silent security **downgrade** — every approval is recorded at
  L1 (`session_tap`) instead of the hardware-backed factor.

Two distinct defects:
1. **Mobile** — regression since #1890 (`92ccd8226`) reintroduced the password
   requirement without updating the mobile client.
2. **Browser** — never worked; `stores/authenticator.ts` has never sent
   `currentPassword` since the first Authenticator commit (#1369).

## Constraint (do NOT drop `currentPassword`)

Per #1890's security review: registration is deferred-proof-of-possession — a new
key is stored `pending` (`last_used_at` null) and activates on its first approval
signature, with no signature at registration time. If a live access token *alone*
could register a key, a stolen-session attacker could enroll their own approver
key and self-sign approvals up to L2/L3, defeating the possession factor.
Registration must be tied to a factor **independent of the bearer token**:
knowledge of the account password, or a fresh interactive login.

## Key realization about the browser

A re-auth grant minted at login has a short TTL (300s). By the time a user
navigates to Settings → "Register this browser," a login-time grant is expired;
making it long-lived would reintroduce the exact stolen-session risk above.
Therefore the **browser must mint a fresh grant at register-time**, which means a
password prompt either way. For the browser, "full re-auth token" and "the
stopgap" converge on the same UX (one password prompt); only the wire path
differs. The token genuinely earns its keep on **mobile**, which must stay
promptless.

## Approach: reuse `mfaStepUpGrant`, one unified register contract

The codebase already has the primitive the issue describes:
`services/mfaStepUpGrant.ts` — Redis-backed, 300s TTL, single-use (`getdel`),
bound to `(userId, operation, authEpoch, mfaEpoch, sid)`. Its only `operation`
today is `'add_factor'`.

**Extend the union with `'register_approver_device'`** and reuse
`mintStepUpGrant` / `validateStepUpGrant` / `consumeStepUpGrant` verbatim. No new
token type, no schema/migration. A grant minted for one operation can never be
consumed for another (`bindsMatch` checks operation equality).

### Server contract

Both register routes stop taking `currentPassword` and take `registerGrantId`:

| Route | Grant handling |
|---|---|
| `POST /authenticator/devices/webauthn/options` (browser) | **validate** (non-consuming) |
| `POST /authenticator/devices/webauthn/verify` (browser) | **consume** |
| `POST /authenticator/devices` (mobile) | **consume** |

Two-phase validate→consume on the browser flow mirrors the existing passkey
`enforceExistingFactorStepUp(..., { consume })` pattern (`routes/auth/passkeys.ts`,
`routes/auth/phone.ts`): the SAME grant is validated at `options` and consumed at
`verify`. A wrong/missing/expired/mismatched grant is a 403 (`register_step_up_required`);
a malformed request stays 400.

Grants are minted two ways:

1. **`POST /authenticator/register-grant { currentPassword }`** — new mint
   endpoint. Runs `requireCurrentPasswordStepUp(c, userId, currentPassword,
   'authenticator:pwd')` (existing rate-limit + argon2 verify), then
   `mintStepUpGrant({ operation: 'register_approver_device', authEpoch, mfaEpoch,
   sid })`. Returns `{ registerGrantId }`. Requires `auth.token.sid` + epochs
   (503 if absent, matching the mfa step-up endpoint). Used by the **browser**.
2. **At login** — `login.ts` mints a `register_approver_device` grant bound to
   the freshly-issued access token's `sid` and returns it as
   `authenticatorRegisterGrantId` in the login response. Minted at BOTH
   interactive-login return points (no-MFA success ~`login.ts:614`, MFA-completed
   success ~`login.ts:920`), never on refresh-token rotation. Best-effort: a mint
   failure (Redis down) omits the field and login still succeeds — mobile simply
   registers on a later login. Used by **mobile**.

## Mobile flow (promptless)

- Login response carries `authenticatorRegisterGrantId`. Store it in **Redux
  (memory only)**, alongside credentials — NOT SecureStore. A cold-start restored
  session (`checkAuth`) does not set it, so a restored session legitimately has no
  grant and correctly skips registration until the next real login. Keeps the
  grant off-disk.
- `RootNavigator`'s existing reactive `[token, user]` effect reads the grant from
  Redux, passes it to `ensureApproverDevice(grant)`, and clears it from Redux
  after the attempt (single-use anyway).
- `ensureApproverDevice(signer, registerGrant?)`:
  - If no grant available → return a new non-error outcome
    `{ status: 'deferred', reason: 'no_reauth_grant' }` (do NOT POST; there is
    nothing to prove with). Treated by the UI like the existing benign
    unregistered state, not a hard failure.
  - If grant available → POST `/authenticator/devices` with `registerGrantId`
    (drop the untrusted `kind`/`isPlatformBound` — server forces them anyway; keep
    `publicKey`, `label`). On success store cred id in SecureStore as today.
- Fail-open unchanged: never throws, never blocks login.

## Browser flow (one password prompt, mirrors passkeys)

- `ApproverDevicesSection.tsx` gains a password field + submit, mirroring
  `ProfilePage.handleAddPasskey`'s password collection. Keep the device-label
  input.
- `stores/authenticator.ts` `registerApproverDevice(label, currentPassword)`:
  1. POST `/authenticator/register-grant` `{ currentPassword }` → `{ registerGrantId }`
     (throw on non-2xx so `runAction` surfaces a real toast — e.g. wrong password → 401).
  2. POST `/authenticator/devices/webauthn/options` `{ registerGrantId }` → options.
  3. `startRegistration({ optionsJSON })`.
  4. POST `/authenticator/devices/webauthn/verify` `{ registerGrantId, label, response }`.
- Caller (`ApproverDevicesSection`) wraps the mutation in `runAction` per the
  no-silent-mutations contract; improve the error toast.

## Security properties preserved

- Registration requires knowledge-of-password (browser) or a fresh interactive
  login (mobile), independent of the bearer token. A stolen access token alone
  cannot mint or replay a grant: single-use (`getdel`), 300s TTL, bound to
  `sid` + `authEpoch` + `mfaEpoch`.
- Deferred-PoP unchanged: rows still insert PENDING (`last_used_at` null) and
  activate on first approval signature.
- The mint endpoint inherits `requireCurrentPasswordStepUp`'s per-user rate limit
  (5 / 5 min); the login-mint adds no new interactive surface.

## Test gap closed

- **API** (`routes/authenticator.test.ts`, new sibling for the mint endpoint):
  - `register-grant`: password happy-path → mints; wrong password → 401;
    rate-limit → 429; missing `sid`/epochs → 503.
  - `options` / `verify` / `devices`: missing grant → 403; mismatched-operation /
    expired / wrong-sid grant → 403; valid grant → 200/201; a valid `add_factor`
    grant is REJECTED on these routes (operation isolation).
  - `login.ts`: successful login response includes `authenticatorRegisterGrantId`;
    a grant-mint failure still returns tokens.
- **Web** (`stores/authenticator.test.ts` — real store, not a mocked
  `registerApproverDevice`): exercises the full client→route sequence against a
  mocked `fetchWithAuth`, asserting the grant is minted then threaded to
  options+verify. This is the drift guard the issue asks for.
- **Mobile** (`services/approverDevice.test.ts`): no grant → no POST, returns
  `deferred`; valid grant → POST body carries `registerGrantId`; existing
  fail-open cases preserved.

## Known tradeoff (documented, not fixed here)

A mobile user who stays logged in for weeks without re-authenticating won't
register until their next fresh login. Acceptable — matches the existing
"provisions on a later login" fail-open behavior, and the #2683 banner already
surfaces the unregistered state to the user.

## Files touched

- `apps/api/src/services/mfaStepUpGrant.ts` — widen `operation` union.
- `apps/api/src/routes/authenticator.ts` — swap `currentPassword` → grant on 3
  routes; add `POST /authenticator/register-grant`.
- `apps/api/src/routes/auth/login.ts` — mint + return `authenticatorRegisterGrantId`
  at both success return points.
- `apps/api/src/routes/auth/schemas.ts` (or the login response type) — add the
  optional field.
- `apps/mobile/src/services/approverDevice.ts` — accept + send grant; `deferred`
  outcome.
- `apps/mobile/src/navigation/RootNavigator.tsx` — thread grant from Redux.
- `apps/mobile/src/store/…` (auth slice) — hold `authenticatorRegisterGrantId` in
  memory; set on login, clear on use/logout.
- `apps/mobile/src/services/auth.ts` (login) — capture the grant from the login
  response into Redux.
- `apps/web/src/stores/authenticator.ts` — `registerApproverDevice(label, currentPassword)`.
- `apps/web/src/components/…/ApproverDevicesSection.tsx` — password field + toast.
- Test files listed above.

## Out of scope

- Active-device co-sign and OOB email confirmation (alternatives considered in
  #2707, rejected).
- Any change to the assurance/enforcement path (`authenticatorAssurance.ts`).
- SecureStore persistence of the grant (deliberately avoided).
