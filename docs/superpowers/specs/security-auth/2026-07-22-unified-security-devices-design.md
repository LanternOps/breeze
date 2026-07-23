# Unified Security Devices — One Identity, One Enrollment, Two Capability Stores

**Date:** 2026-07-22
**Status:** Design — draft for review
**Related:** #2707 (approver-device registration grants, PR #2710), `2026-06-14-breeze-authenticator-step-up-approvals-design.md`, `2026-06-15-authenticator-registration-redesign-design.md`, `docs/superpowers/specs/2026-07-21-authenticator-register-grant-design.md`
**Depends on:** the add-passkey `add_factor` step-up wiring (branch `ToddHebebrand/passkeys-registration`) — this spec assumes that flow is merged.

## 1. Problem

`/settings/profile` presents what looks like three separate identity systems: an MFA card (TOTP), a Passkeys card (`user_passkeys`, login factors), and an Approval-security card (`authenticator_devices`, approval factors). A technician enrolling one physical laptop for both sign-in and approvals runs **two nearly identical Touch ID / Windows Hello ceremonies** through two different forms, producing two credentials that the UI presents as unrelated features. The natural user question — "isn't my identity one thing?" — is correct: both stores hang off the same `users` row and the same WebAuthn RP config (`approverWebAuthn.ts` imports `resolveWebAuthnConfig()` from `services/passkeys.ts`). What differs is credential *capability*, but the product presents it as duplicated *identity*.

The recently added section grouping ("Sign-in security" / "Approvals") explains the split; this spec dissolves the enrollment and presentation halves of it without weakening the security architecture underneath.

## 2. What stays separate, and why (non-negotiable)

The two credential stores remain two stores. The separation is load-bearing:

| Property | `user_passkeys` (sign-in) | `authenticator_devices` (approvals) |
|---|---|---|
| Purpose | Gate session creation | Sign per-approval challenges bound to `{approvalId, nonce}` |
| Syncability | Synced/roaming credentials acceptable | `isPlatformBound` (attestation-derived: `singleDevice && !backedUp`) gates L4 |
| Registration side-effects | Flips `mfaEnabled`, bumps `mfa_epoch`, revokes refresh families | None — opt-in, pending until first approval signature (deferred PoP) |
| Step-up gate | `add_factor` grant, **with** no-factor bypass (enrollment chicken-and-egg) | `register_approver_device` grant, **no bypass ever** (stolen bearer token must never enroll a self-approving key — the T4-revert lesson) |
| Non-WebAuthn members | none | `mobile_hw_key` (Secure Enclave raw RSA, not WebAuthn) |
| Revocation blast radius | Can lock out login | Never affects login |

**Grant operations stay non-interchangeable.** A grant is bound to exactly one operation at mint and re-checked at consume (`mfaStepUpGrant.ts`); nothing in this spec relaxes that.

## 3. Goals

1. **One ceremony, both capabilities.** Registering a passkey from the web offers "also use this device to approve high-risk actions" — a single `navigator.credentials.create()` producing one credential recorded in both stores.
2. **One list.** Replace the Passkeys and Approval-security cards with a single **Security devices** card: every credential (login passkeys, browser approver credentials, auto-registered phones) as one row with capability badges.
3. **A retrofit path.** An existing login passkey on the current device can gain the Approvals capability without creating a new key.
4. **Every security property in §2 preserved verbatim.**

### Non-goals

- Merging the tables, or any schema migration (none is needed — see §4.3).
- Changing the assurance ladder, risk→tier mapping, or `assertApprovalAssurance`.
- Mobile changes: phones keep silent-at-login provisioning (#2707); they simply *appear* in the unified list, as `ApproverDevicesSection` already lists them.
- TOTP/SMS — the MFA card is untouched.
- Fixing the SMS add-factor gap (SMS-method accounts have no authenticated step-up code sender; tracked separately, see §8).

## 4. Design

### 4.1 Multi-operation step-up mint

One factor proof should mint the grants for both registrations. Extend `POST /auth/mfa/step-up`:

- Request: `operations: StepUpOperation[]` (new, 1–2 entries, deduped) alongside the existing `operation` (kept for back-compat; exactly one of the two fields allowed).
- Response: `grants: [{ operation, stepUpGrantId }]` alongside the existing top-level `stepUpGrantId` (populated when the legacy `operation` form is used).
- Each grant is minted, stored, and consumed exactly as today — same TTL (300 s), same single-use `getdel`, same `{userId, operation, authEpoch, mfaEpoch, sid}` binding. Multi-mint changes *how many* grants one proof yields, not what any grant can do.

**Security argument:** any factor proof that can mint `add_factor` today can immediately be re-proved to mint `register_approver_device` (and vice versa) — the same TOTP code window or a second passkey assertion. Batching removes a redundant user prompt, not a security boundary. Rate limiting (`mfa:stepup-rl:`) applies per proof, unchanged.

**Unprotected accounts (first factor):** `add_factor` is bypassed (no grant needed) and `register_approver_device` has its password fallback (`POST /authenticator/register-grant`, refused when a stronger factor exists). The combined flow therefore needs only the password the add-passkey form already collects. No new bypass is introduced.

### 4.2 Dual enrollment at `/auth/passkeys/register/verify`

Add to the verify schema: `approverRegisterGrantId?: string` and `approverLabel?: string`.

Flow inside the handler, after WebAuthn verification succeeds:

1. Existing behavior unchanged: consume the `add_factor` grant (when required), insert `user_passkeys`, flip `mfaEnabled`, bump epoch, revoke refresh families — all in the existing `invalidateMfaAssuranceAfterFactorChange` transaction.
2. If `approverRegisterGrantId` present: enforce `enforceApproverRegisterStepUp(consume: true)` — the full no-bypass gate, identical to `/authenticator/devices/webauthn/verify`, including the `auth.authenticator.register.denied` audit on failure. On success, insert an `authenticator_devices` row **in the same transaction** as step 1: `kind: 'webauthn_platform'`, same `credentialId`/`publicKey`, `isPlatformBound` derived from the verified attestation (`credentialDeviceType === 'singleDevice' && !backedUp`), `lastUsedAt: null` (deferred proof-of-possession, exactly like the standalone flow — the row activates on its first real approval signature).
3. Response gains `approver: { registered: boolean, isPlatformBound?: boolean, reason?: 'grant_invalid' }` so the UI can report each capability's outcome honestly (e.g. "registered for approvals — synced credential, not eligible for critical-tier approvals").

**Partial-failure semantics:** an invalid/expired approver grant must **not** roll back the passkey insert (the user proved everything the passkey required). Step 2 failure degrades to `approver.registered: false` with the passkey created; the UI offers the §4.4 retrofit as the retry path. The reverse cannot happen (approver insert only runs after passkey insert succeeds in the same transaction — a DB error rolls back both).

**Synced credentials are allowed**, mirroring current standalone approver registration, which accepts them and flags `isPlatformBound: false` (L2-capable, L4-ineligible). The UI labels this rather than hiding the option.

**Sign-count note:** one credential now has two counter columns (`user_passkeys.counter`, `authenticator_devices.signCount`). Each context sees forward *jumps* when the other context uses the credential; both verifiers only reject *decreases*, and platform authenticators typically report 0 anyway. Verified acceptable; add a regression test asserting a login between two approvals does not trip the approver clone check (and vice versa).

### 4.3 No schema change

`authenticator_devices.credentialId` is already `unique` and both stores already carry `publicKey`/`aaguid`/`transports`. Dual registration is two rows sharing a `credentialId` value across tables. Join for display; never join for verification (each ceremony verifies against its own store, unchanged). No migration, no RLS change (both tables stay Shape 6, already in `USER_ID_SCOPED_TABLES`), no cascade-list change (both already registered).

### 4.4 Retrofit: add Approvals to an existing passkey

New route `POST /authenticator/devices/webauthn/adopt`:

- Body: `{ registerGrantId, credentialId, label? }`.
- Gate: `enforceApproverRegisterStepUp` (validate at a paired `/adopt/options` challenge issuance, consume at adopt — same two-phase contract as every other registration route).
- Proof of possession: the client runs an **assertion ceremony** over a fresh challenge restricted to `allowCredentials: [credentialId]` (reusing the `approver-reg:<userId>` Redis challenge namespace). A row copied on the say-so of a bearer token would violate the no-bypass posture; the assertion proves the key is present on this device *now*. On verify: insert the `authenticator_devices` row from the `user_passkeys` record's public key, `isPlatformBound` from the stored `deviceType`/`backedUp`, and — because possession was just proven live — set `lastUsedAt: now` (no deferred-PoP pending state; the assertion *was* the possession proof).
- UI: on rows with only the Sign-in badge, an "Enable approvals" action → step-up (reusing `StepUpPrompt`) → silent assertion → badge appears.

### 4.5 Unified "Security devices" card

Replace the Passkeys card and `ApproverDevicesSection` on `/settings/profile` with one `SecurityDevicesCard`:

- **Data:** `GET /auth/passkeys` + `GET /me/approver-devices`, merged client-side on `credentialId` (a passkey and approver device sharing one are one row; `mobile_hw_key` rows and unmatched entries stay their own rows).
- **Row:** name, created/last-used, badges: `Sign-in`, `Approvals`, `Platform-bound`, `Pending — activates on first approval` (existing pending semantics), `Synced` (when a sign-in credential has `backedUp`).
- **Actions:** Rename (updates whichever rows exist; labels are per-store columns — write both). Remove is **per-capability** with explicit consequences: "Remove sign-in" = existing passkey DELETE (password-gated, may affect MFA status); "Revoke approvals" = existing revoke (instant, never affects login). A combined row offers both; no single "delete everything" button hides the asymmetry.
- **Add flow:** the existing add-passkey form (password + `add_factor` step-up from the current branch) gains one checkbox, default **on**: "Also use this device to approve high-risk actions." Checked → mint both grants in one step-up (§4.1) and send `approverRegisterGrantId` to verify (§4.2). The standalone "register this browser for approvals only" path remains for users who don't want a login passkey (parity with today's `ApproverDevicesSection`).
- The "Sign-in security" / "Approvals" page-group headers from the current branch collapse to a single "Security devices" group plus the MFA card.

### 4.6 What the approvals card keeps

`registerApproverDevice()` / `stores/authenticator.ts`, `/authenticator/devices/webauthn/*`, revoke/rename routes, and mobile provisioning are all unchanged — `SecurityDevicesCard` is a new consumer of the same service layer, plus the two new endpoints (`step-up` multi-op, `adopt`).

## 5. Security invariants (checklist for review + tests)

1. `register_approver_device` is consumed by the no-bypass gate on every path that writes an `authenticator_devices` row — including the new §4.2 and §4.4 paths (audit `auth.authenticator.register.denied` on every denial).
2. `add_factor` bypass applies only to `user_passkeys`/MFA writes, never to approver writes.
3. Epoch bump + refresh-family revoke fire on login-factor changes only; adopt (§4.4) and approver revoke never touch them.
4. Dual-enroll partial failure never leaves an approver row without a consumed approver grant, and never rolls back a legitimately-earned passkey.
5. `isPlatformBound` is always attestation-derived server-side; the client's checkbox controls *whether* to register, never the flag.
6. Grant operations remain non-interchangeable (multi-mint returns distinct per-operation grants; consume re-checks binding).
7. Cross-store sign-count jumps are tolerated in both verifiers; decreases still reject.

## 6. Implementation sketch

**Phase 1 — API (grants + dual write):** `mfaStepUpSchema` `operations[]` + response shape; `registerVerifySchema` `approverRegisterGrantId`/`approverLabel` + transactional dual insert + `approver` response block. Unit tests for multi-mint, dual-write success/partial-failure, gate denial audit.

**Phase 2 — Web (unified card):** `SecurityDevicesCard` (merge logic, badges, per-capability actions, add-flow checkbox); delete the Passkeys card JSX and `ApproverDevicesSection` usage from `ProfilePage`; migrate that section's tests. i18n in all 5 locales.

**Phase 3 — Retrofit:** `/adopt/options` + `/adopt` routes with assertion PoP; "Enable approvals" row action. Integration test proving a stolen-token adopt (no grant / no assertion) fails closed.

Each phase ships independently; Phase 2 is useful even if Phase 3 slips.

## 7. Open questions

1. **Checkbox default.** Default-on maximizes approver coverage (good for partners moving toward enforced policies) but registers a capability some users didn't ask for. Proposal: default-on with the badge-labeled outcome visible in the success state; revisit if support noise appears.
2. **Label divergence.** Pre-existing dual credentials (registered separately before this ships) may have different names in each store. Proposal: display the passkey name, show the approver label as secondary text until renamed once (which converges them).
3. **Should adopt also work in reverse** (approver-only credential gains Sign-in)? Deliberately excluded: adding a login factor has session-revocation side effects and its own step-up semantics; the asymmetry is the point. Revisit only with a concrete user need.

## 8. Out-of-scope gap worth its own issue

SMS-method accounts cannot mint any `add_factor` grant from the web (no authenticated step-up SMS sender; the only send route is login-time, tempToken-keyed). The current branch surfaces this honestly (disabled button + note). An authenticated `POST /auth/mfa/step-up/sms/send` (rate-limited, `mfaEnabled && mfaMethod='sms' && phoneVerified` allowlist, mirroring the C1 guard in `/auth/mfa/step-up`) would close it and automatically light up the SMS tier in both the add-passkey and dual-enroll flows. File as a separate issue; do not fold into Phase 1.
