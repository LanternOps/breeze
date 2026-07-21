# Authenticator approver-device registration — grant-based re-auth

**Issue:** #2707
**Date:** 2026-07-21 (rev 2 — corrected mint points, added MFA/passkey re-auth
path, UX pass; re-verified against code after a second review round)
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

## Constraint (do NOT drop re-auth)

Per #1890's security review: registration is deferred-proof-of-possession — a new
key is stored `pending` (`last_used_at` null) and activates on its first approval
signature, with no signature at registration time. If a live access token *alone*
could register a key, a stolen-session attacker could enroll their own approver
key and self-sign approvals up to L2/L3, defeating the possession factor.
Registration must be tied to **one factor independent of the bearer token**:
knowledge of the account password, proof of an existing MFA factor
(TOTP/SMS/passkey), or a fresh interactive login. This matches the bar #1890 set
(password alone — a single independent factor — was sufficient); we widen *which*
factor qualifies, not how many are required.

## Key realization about the browser

A re-auth grant minted at login has a short TTL (300s). By the time a user
navigates to Settings → "Register this browser," a login-time grant is expired;
making it long-lived would reintroduce the exact stolen-session risk above.
Therefore the **browser must mint a fresh grant at register-time**, which means a
re-auth prompt either way. The login-time grant genuinely earns its keep on
**mobile**, which must stay promptless.

## Browser re-auth: existing factor preferred, password as fallback

Decision (rev 2): the browser prompt is **not** password-only. The API already
has `POST /auth/mfa/step-up` (`routes/auth/mfa.ts:721`, SR2-20): a discriminated
union on `method` verifying **TOTP, SMS, or a passkey assertion** (passkey
challenge from `POST /auth/mfa/step-up/options`), per-user rate-limited
(`mfa:stepup-rl:`), audited, minting a 300s single-use grant — today hardcoded to
`operation: 'add_factor'` (`mfa.ts:798`).

Method selection, best UX first — the UI offers exactly one, and the server
enforces the same tiering:

1. **Passkey** (user has ≥1 passkey): one Touch ID / Windows Hello tap. No
   typing, phishing-resistant, and it's the natural gesture right before a
   WebAuthn *registration* ceremony.
2. **TOTP code** (`mfaMethod === 'totp'`, no passkey): 6-digit code entry.
3. **Password** (no passkey and no TOTP — including SMS-method MFA users, see
   below): password field, exactly the pre-rev-2 flow.

**SMS is deliberately NOT offered** as a browser re-auth method: the step-up
endpoint can *check* an SMS code (`mfa.ts:750-773`) but nothing can *send* one
to an authenticated user — the login sender `POST /auth/mfa/sms/send`
(`routes/auth/phone.ts:322`) is pre-auth and tempToken-gated, and
`/phone/verify` sends to a client-supplied number for phone *setup*. An
authenticated "send step-up SMS" endpoint would be new abuse surface for
marginal gain; SMS-method users take the password path instead (SIM-swap-prone
SMS is not meaningfully stronger than password re-auth).

**Server-side gate on the password path**: `POST /authenticator/register-grant`
refuses password re-auth (403, distinct error code, e.g.
`stronger_factor_required`) when the account has a TOTP secret or ≥1 passkey.
Without this the UI tiering is decoration — a direct API caller with a stolen
session + phished password could register an approver key on an MFA-protected
account, an asymmetry vs. the SR2-20 `add_factor` contract (which blocks
exactly that via `enforceExistingFactorStepUp`). With it, server and UI agree:
strongest available factor, password only when nothing stronger exists.

**Data source for the UI**: passkey count is already in ProfilePage's data and
`mfaEnabled` is on `GET /users/me`, but **`mfaMethod` is not exposed post-login
anywhere** — add it to `GET /users/me` (`routes/users.ts`, one field off the
user's own row).

This also unlocks **SSO-only / passwordless accounts** (`users.password_hash` is
nullable; `requireCurrentPasswordStepUp` 401s them) as long as they have a
passkey or TOTP. SSO-only accounts with neither remain unable to register a
browser approver device — documented limitation (see Known tradeoffs).

Considered and rejected: requiring password **and** existing-factor step-up
together (the SR2-20 `add_factor` contract for MFA-protected accounts). #1890's
bar is one independent factor, the mobile path (fresh login) already satisfies it
with one composite event, and double-prompting is exactly the friction that keeps
approver enrollment at zero. The server-side gate above keeps the one-factor bar
but requires it to be the *strongest available* factor.

## Approach: reuse `mfaStepUpGrant`, one unified register contract

`services/mfaStepUpGrant.ts` — Redis-backed, 300s TTL, single-use
(`consumeStepUpGrant` = GETDEL) with a separate non-consuming
`validateStepUpGrant` (GET), keys are **random UUIDs** (`mfa:stepup:<uuid>`, so
concurrent grants for the same user coexist — two devices logging in within the
TTL never clobber each other), bound to
`(userId, operation, authEpoch, mfaEpoch, sid)` via `bindsMatch`.

**Extend the `operation` union with `'register_approver_device'`** and reuse
`mintStepUpGrant` / `validateStepUpGrant` / `consumeStepUpGrant` verbatim. No new
token type, no schema/migration. A grant minted for one operation can never be
consumed for another (`bindsMatch` checks operation equality).

> **Implementation warning — do NOT reuse `enforceExistingFactorStepUp`**
> (`routes/auth/helpers.ts:284`). That helper early-returns null (pass) for
> non-MFA-protected accounts (`userIsMfaProtected` check at `helpers.ts:290`) —
> correct for `add_factor`, catastrophic here: it would let a stolen bearer
> token register an approver key for every non-MFA user. Write an unconditional
> sibling (same 503-on-missing-sid/epochs, same 403 shape) that enforces the
> grant for **all** users. A test must pin this: non-MFA user, no grant → 403.

### Server contract

All three register routes stop taking `currentPassword` and take
`registerGrantId`:

| Route | Grant handling |
|---|---|
| `POST /authenticator/devices/webauthn/options` (browser) | **validate** (non-consuming) |
| `POST /authenticator/devices/webauthn/verify` (browser) | **consume** |
| `POST /authenticator/devices` (mobile) | **consume** |

Two-phase validate→consume mirrors the passkey/phone/TOTP
`{ consume: false }` → `{ consume: true }` pattern: the SAME grant is validated
at `options` and consumed at `verify`. A wrong/missing/expired/mismatched grant
is a 403 (`register_step_up_required`); a malformed request stays 400. Note this
*strengthens* the browser flow: today `registerVerifySchema` has no step-up at
all — the password is only checked at `options`.

Grants are minted three ways:

1. **`POST /auth/mfa/step-up` with `operation: 'register_approver_device'`** —
   extend `mfaStepUpSchema` with an optional `operation` enum defaulting to
   `'add_factor'` (back-compat). The schema is a `z.discriminatedUnion` on
   `method` (`schemas.ts:121-125`), so the field goes on each branch (or a
   merged base) — you can't `.extend()` the union; with a per-branch
   `.default('add_factor')` the existing `zValidator` usage is unaffected.
   Verification, rate limiting, and the `auth.mfa.stepup.granted` audit (which
   already records `operation`) are untouched. The endpoint returns
   `{ stepUpGrantId }` (`mfa.ts:816`); the client passes that value as
   `registerGrantId` to the register routes. Used by the **browser** for the
   passkey and TOTP methods (the SMS branch stays API-only, see above).
2. **`POST /authenticator/register-grant { currentPassword }`** — new mint
   endpoint. Refuses (403 `stronger_factor_required`) when the account has a
   TOTP secret or ≥1 passkey — the server-side gate above. Otherwise runs
   `requireCurrentPasswordStepUp(c, userId, currentPassword,
   'authenticator:pwd')` — deliberately the SAME rate-limit prefix the register
   routes use today, so the 5 / 5 min per-user bucket carries over — then
   `mintStepUpGrant({ operation: 'register_approver_device', ... })`. Returns
   `{ registerGrantId }`. 503 if `sid`/epochs absent (matching `/auth/mfa/step-up`).
   Used by the **browser** password fallback.
3. **At login** — mint a `register_approver_device` grant bound to the
   freshly-issued access token's `sid` and return it as
   `authenticatorRegisterGrantId` — **only when the request carries the mobile
   device-id header** both handlers already read (`login.ts:568` /
   `mfa.ts:338`). Web logins hit these same endpoints; without the gate every
   browser login would mint a needless Redis grant and hand a live register
   grant to the page context (readable by XSS for 300s). Best-effort: a mint
   failure (Redis down) omits the field and login still succeeds — mobile simply
   registers on a later login. Used by **mobile** only.

### Login mint points (corrected in rev 2 — verify against code, not this doc's line numbers)

The two mint points are the two endpoints mobile actually logs in through:

| Path | Where | Response |
|---|---|---|
| No-MFA password login | `routes/auth/login.ts` `POST /auth/login` success (mint ~`login.ts:555`, response ~`:614`) | add field |
| MFA-completed login | **`routes/auth/mfa.ts`** `POST /auth/mfa/verify` success (mint ~`mfa.ts:327`, response ~`:364`) | add field |

At the `mfa.ts` point all bind material is in scope: `epochs` (`mfa.ts:325`) and
`sid` = the refresh family id (`mfa.ts:324`; `jwt.ts:373` sets `sid:
options.refreshFam`).

**NEVER mint on `POST /auth/refresh`** (`login.ts:700`, re-mint `:907`, response
`:932`). rev 1 misidentified this block ("~line 920") as the MFA success point —
it is token *rotation*. Minting there would hand a stolen-refresh-token attacker
a fresh register grant every rotation, inverting the Constraint above. A test
must assert the refresh response never contains `authenticatorRegisterGrantId`.

**Deliberately skipped** fresh-login paths — all web-only, and the browser mints
at register time so a login-time grant would only expire unused: passkey-as-MFA
(`passkeys.ts:476`), SSO callback (`sso.ts:2937`), both Cloudflare Access paths
(`cfAccessLogin.ts:241`, `cfAccessRedirectLogin.ts:215`), accept-invite
(`invite.ts:205`), verify-email (`verifyEmail.ts:438`). Mobile supports only
password + TOTP/SMS (`MfaMethod` in `apps/mobile/src/services/api.ts:96`), so
these paths cannot serve a mobile registration.

There is **no shared login-response type to edit**: each handler returns an
inline literal, and `packages/shared/src/types/auth.ts` `LoginResponse` is
imported nowhere (dead). Add the optional field to both handler literals, the
OpenAPI `LoginResponse` schema (`openapi.ts:121`), and mobile's own
`LoginResponse` in `services/api.ts`.

## Mobile flow (promptless)

- Both `login()` (`api.ts:315`) and `verifyMfa()` (`api.ts:343`) capture
  `authenticatorRegisterGrantId` from their responses — MFA users get the grant
  from `/auth/mfa/verify`, not the initial login POST.
- Store it in **Redux (memory only)** — NOT SecureStore. Cold-start restore
  (`checkAuth` → `setCredentials`) rebuilds state solely from
  `getStoredToken`/`getStoredUser`, so a restored session legitimately has no
  grant and correctly skips registration until the next real login. Keeps the
  grant off-disk.
- `RootNavigator`'s existing reactive `[token, user]` effect reads the grant
  from Redux and passes it to `ensureApproverDevice(signer, grant)`.
  **Read-and-clear the grant from Redux synchronously BEFORE the async
  attempt**, not after: the effect re-fires on every `user` identity change
  (`checkAuth` double-dispatches on cold start; the `active` cleanup discards
  stale outcomes but does not prevent concurrent in-flight calls). Clearing
  first means a second firing sees no grant → `deferred`, instead of racing a
  consumed grant to a 403 whose `failed` outcome could overwrite a successful
  registration. Belt-and-braces: a module-level single-flight guard in
  `ensureApproverDevice`.
- `ensureApproverDevice(signer, registerGrant?)`:
  - If no grant available → return a new non-error outcome
    `{ status: 'deferred', reason: 'no_reauth_grant' }` (do NOT POST; there is
    nothing to prove with). Treated by the UI like the existing benign
    unregistered state, not a hard failure.
  - If grant available → POST `/authenticator/devices` with `registerGrantId`
    (drop the untrusted `kind`/`isPlatformBound` — the server already forces
    `mobile_hw_key`/`true` on insert; keep `publicKey`, `label`). On success
    store cred id in SecureStore as today.
- Fail-open unchanged: never throws, never blocks login.

## Browser flow (one re-auth gesture, best method offered first)

- `ApproverDevicesSection.tsx` (already `runAction`-wrapped for register /
  revoke / rename — no allowlist entry needed) gains a small **re-auth step**
  ahead of the existing label input:
  - user has ≥1 passkey (from the profile factor data) → primary button
    **"Verify with passkey"**;
  - else `mfaMethod === 'totp'` (newly exposed on `/users/me`) → 6-digit TOTP
    input;
  - else → password field (SMS-method users land here — see Browser re-auth).
  Build it as a small reusable component (e.g. `StepUpPrompt`) — ProfilePage's
  add-passkey flow currently dead-ends for MFA-protected users, surfacing the
  raw `existing_factor_step_up_required` code with no way to satisfy it, and
  will want the same component (follow-up, out of scope here).
- `stores/authenticator.ts` `registerApproverDevice(label, reauth)` where
  `reauth` is `{ password } | { method: 'totp' | 'sms', code } |
  { method: 'passkey' }`:
  1. Mint: password → `POST /authenticator/register-grant`; code →
     `POST /auth/mfa/step-up { method, code, operation }`; passkey →
     `POST /auth/mfa/step-up/options` → `startAuthentication` →
     `POST /auth/mfa/step-up { method: 'passkey', credential, operation }`.
     Throw on non-2xx so `runAction` surfaces a real toast.
  2. `POST /authenticator/devices/webauthn/options` `{ registerGrantId }`.
  3. `startRegistration({ optionsJSON })`.
  4. `POST /authenticator/devices/webauthn/verify` `{ registerGrantId, label, response }`.

### UX details

- **Error mapping, not raw codes**: 401 → "Incorrect password" / "Incorrect
  code"; 429 → "Too many attempts — try again in a few minutes"; 403
  `register_step_up_required` at options/verify → the grant expired mid-ceremony
  (>300s in the WebAuthn prompt) — reset to the re-auth step with the label
  preserved and say "Verification expired — please verify again," don't
  dead-toast.
- **Success state**: refresh the device list and show the new device row with
  its "pending — activates on first approval" state so the user isn't left
  wondering whether it worked.
- **Mobile banner copy** (#2683 banner): the new `deferred` status is
  actionable — "Sign out and back in to finish approver setup" — distinct from
  the generic unregistered state.

## Security properties preserved

- Registration requires an independent factor: password or existing MFA factor
  (browser), or a fresh interactive login (mobile). A stolen access token alone
  cannot mint or replay a grant: single-use (GETDEL), 300s TTL, bound to
  `sid` + `authEpoch` + `mfaEpoch` (an epoch bump — e.g. admin MFA reset —
  invalidates outstanding grants via `bindsMatch`).
- Grant enforcement on the register routes is **unconditional** (see the
  `enforceExistingFactorStepUp` warning above) — no MFA-protected bypass.
- Deferred-PoP unchanged: rows still insert PENDING (`last_used_at` null) and
  activate on first approval signature (`authenticatorAssurance.ts:333`/`:391`).
- Repo-wide, the only inserts into `authenticator_devices` are the two in
  `authenticator.ts` — no other registration path needs the gate.
- Rate limits: password path inherits `authenticator:pwd` (5 / 5 min per user);
  step-up path inherits `mfa:stepup-rl:`; login-mint adds no new interactive
  surface.

## Test gap closed

- **API** (`routes/authenticator.test.ts` + sibling for the mint endpoint):
  - `register-grant`: password happy-path (no stronger factor) → mints; wrong
    password → 401; passwordless account → 401; account with TOTP or a passkey
    → 403 `stronger_factor_required` (password path gated); rate-limit → 429;
    missing `sid`/epochs → 503.
  - `/auth/mfa/step-up` with `operation: 'register_approver_device'`: mints a
    grant the register routes accept; omitted `operation` still mints
    `add_factor` (back-compat); a `register_approver_device` grant is REJECTED
    by the `add_factor` consumers and vice versa (operation isolation, both
    directions).
  - `options` / `verify` / `devices`: missing grant → 403 **including for a
    non-MFA-protected user** (pins the no-bypass requirement); mismatched-operation /
    expired / wrong-sid grant → 403; valid grant → 200/201; same grant validated
    at options then consumed at verify; replayed consumed grant → 403.
  - Login mints: `POST /auth/login` (no-MFA) and `POST /auth/mfa/verify`
    responses include `authenticatorRegisterGrantId` **when the mobile
    device-id header is present, and omit it when absent** (web logins never
    receive a grant); a grant-mint failure still returns tokens;
    **`POST /auth/refresh` response NEVER includes it**.
  - `GET /users/me` includes `mfaMethod`.
- **Web** (`stores/authenticator.test.ts` — real store, not a mocked
  `registerApproverDevice`): for each re-auth method, exercises the full
  client→route sequence against a mocked `fetchWithAuth`, asserting the grant is
  minted then threaded to options+verify. This is the drift guard the issue
  asks for.
- **Mobile** (`services/approverDevice.test.ts`): no grant → no POST, returns
  `deferred`; valid grant → POST body carries `registerGrantId` and no
  `kind`/`isPlatformBound`; concurrent double-invoke consumes the grant once;
  existing fail-open cases preserved.

## Known tradeoffs (documented, not fixed here)

- A mobile user who stays logged in for weeks without re-authenticating won't
  register until their next fresh login. Acceptable — matches the existing
  "provisions on a later login" fail-open behavior; the #2683 banner surfaces it
  with the new actionable copy.
- **SSO-only accounts with neither a passkey nor TOTP** (including SMS-only
  MFA) cannot register a browser approver device (nothing independent of the
  bearer token to prove). Not a regression — they were equally locked out of
  the password-only flow — but now explicit. Follow-up option: mint a
  browser-usable grant at the SSO callback and auto-prompt registration
  immediately after login, within the 300s window.
- ProfilePage's add-passkey dead-end for MFA-protected users (unhandled
  `existing_factor_step_up_required` 403) is a pre-existing bug this spec does
  not fix; the `StepUpPrompt` component built here is the intended vehicle.

## Files touched

- `apps/api/src/services/mfaStepUpGrant.ts` — widen `operation` union.
- `apps/api/src/routes/auth/schemas.ts` — add optional `operation` to
  `mfaStepUpSchema`.
- `apps/api/src/routes/auth/mfa.ts` — thread `operation` through
  `POST /auth/mfa/step-up`; mint + return `authenticatorRegisterGrantId` at the
  `POST /auth/mfa/verify` success point.
- `apps/api/src/routes/auth/login.ts` — mint + return the field at the no-MFA
  success point ONLY (not refresh).
- `apps/api/src/routes/auth/helpers.ts` (or `authenticator.ts`) — unconditional
  grant-enforcement helper (see warning).
- `apps/api/src/routes/authenticator.ts` — swap `currentPassword` → grant on 3
  routes; add `POST /authenticator/register-grant` (with the
  stronger-factor gate).
- `apps/api/src/routes/users.ts` — expose `mfaMethod` on `GET /users/me`.
- `apps/api/src/openapi.ts` — document the login-response field (note:
  `LoginResponse` is also `$ref`'d by `/auth/register`, which won't return it —
  scope the doc accordingly).
- `apps/mobile/src/services/api.ts` — capture the grant in `login()` and
  `verifyMfa()`; extend mobile `LoginResponse`.
- `apps/mobile/src/services/approverDevice.ts` — accept + send grant; `deferred`
  outcome; single-flight guard.
- `apps/mobile/src/navigation/RootNavigator.tsx` — thread grant from Redux
  (read-and-clear before the attempt).
- `apps/mobile/src/store/authSlice.ts` — hold `authenticatorRegisterGrantId` in
  memory; set on login/verifyMfa, clear on read/logout.
- `apps/web/src/stores/authenticator.ts` — `registerApproverDevice(label, reauth)`.
- `apps/web/src/components/settings/ApproverDevicesSection.tsx` — re-auth step
  (`StepUpPrompt`), error mapping, pending-state success UI (plus profile-store
  plumbing for `mfaMethod`).
- Test files listed above.

## Out of scope

- Active-device co-sign and OOB email confirmation (alternatives considered in
  #2707, rejected).
- Any change to the assurance/enforcement path (`authenticatorAssurance.ts`).
- SecureStore persistence of the grant (deliberately avoided).
- Fixing ProfilePage's add-passkey step-up dead-end (follow-up; reuse
  `StepUpPrompt`).
- Requiring password + existing factor together (rejected, see Browser re-auth).
- An authenticated step-up SMS-send endpoint (rejected — new abuse surface;
  SMS-method users use the password path).
