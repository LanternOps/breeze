# Breeze Authenticator — Registration & Assurance Redesign

**Date:** 2026-06-15
**Status:** Design — approved, pending implementation plan
**Revises:** `docs/superpowers/specs/security-auth/2026-06-14-breeze-authenticator-step-up-approvals-design.md` and **PR #1369** (unmerged). This is a revision of an in-flight feature, not a greenfield build.
**Related:** #1254 (mobile approval bridge), Discussion #858 (PAM).

## 1. Problem

PR #1369 shipped the Breeze Authenticator (risk-tiered step-up approvals). The assurance ladder and the server guard are sound, but the **enrollment experience is wrong**:

1. **Registration is a separate ceremony.** A technician who has already installed the app, logged in, and enabled Face ID must *also* go to Settings → "Set Up Authenticator" → re-enter their password → tap Register → approve a biometric → set a PIN. That sheet was in fact never even wired into a screen (orphaned), but the deeper issue is that it *should not exist as a distinct step at all*.
2. **The phone and the web are disconnected.** The web "Approval security" panel only registers *the current browser*; it never mentions or surfaces the phone. A user looking there sees "no option for the mobile app."
3. **The PIN adds friction for marginal value** (see §5).

The premise we want: **the phone is an approver because it is your trusted, logged-in device.** No second enrollment.

## 2. Goals

- Eliminate the separate "Set Up Authenticator" step. The Secure-Enclave approver key provisions **silently at login**.
- The first biometric prompt a technician ever sees is a *real approval*, not a setup ceremony.
- The web "Approval security" panel **lists auto-registered phones**; browser registration stays optional.
- Simplify the L3/L4 factors: **remove the static PIN**; add a fresh re-authentication at L4 only.
- Preserve every security property that matters: hardware-bound non-exportable key, fresh per-approval request-bound signature, the risk→tier ladder, the single `assertApprovalAssurance` server guard.

### Non-goals

- Changing the risk→tier mapping (`low→L1 … critical→L4`) — unchanged.
- Changing login MFA (passkeys/TOTP) — unchanged.
- Desktop Helper as an approval surface — still out of scope.
- A "scan QR on web to link the phone" flow — unnecessary; the app self-registers at its own login.

## 3. Decisions (summary)

| Area | Before (#1369) | After (this redesign) |
|---|---|---|
| Mobile registration | Manual "Set Up Authenticator" sheet + password re-entry | **Silent at login**; key minted during onboarding, no screen |
| First biometric | At registration | At the **first real approval** |
| Catch existing users | n/a | **Just-in-time**: provision on first approval that needs it |
| Web panel | "Register this browser" only | **Lists registered phones** + optional "register this browser" |
| Browser approver | Independent approver | **Optional** approver (kept) |
| L3 (high) factor | biometric + **PIN** | biometric signature + **recency check** |
| L4 (critical) factor | biometric + PIN + hw-bound key | hw-bound key + **fresh account re-auth** (password / login-MFA) |
| PIN | `users` columns + `pin.ts` service + UI | **Removed entirely** |

## 4. Registration: the phone just works

**Key insight:** creating a hardware key (`react-native-biometrics.createKeys()`) does **not** trigger a biometric prompt — only *signing* (`createSignature()`) does. So the key can be minted with zero user-visible friction; the biometric only appears when the tech first approves.

**Flow (fresh login):**
1. Tech logs in on the phone (existing flow — password, optional login-MFA).
2. On auth success, the app calls a new idempotent `ensureApproverDevice()` step (hooked into `authSlice.loginAsync.fulfilled` **and** the restored-session path `setCredentials` in `RootNavigator`):
   - If this device already has a registered, active approver key for this user → no-op.
   - Else: `createKeys()` → `POST /api/v1/authenticator/devices { kind:'mobile_hw_key', publicKey, label, mobileDeviceId, isPlatformBound:true }`. **No password step-up** — the just-completed login *is* the authentication.
3. Server stores the row as `pending` and issues a proof-of-possession nonce. **PoP is deferred to first use** (see below) so login stays prompt-free; the row is usable for assurance only after the first successful signature confirms possession.

**Proof-of-possession without a login-time prompt:** rather than forcing a biometric signature at registration (which would surface a Face ID at login), the **first approval signature doubles as PoP**. `assertApprovalAssurance` verifies the signature against the stored `pending` key and, on success, flips the device to `active`. A key that never signs never activates — same anti-bogus-key guarantee, no login friction.

**Existing logged-in users (JIT fallback):** users already authenticated when this ships have no `ensureApproverDevice()` provisioning. They get it lazily: the next time the app foregrounds (or the next approval) runs `ensureApproverDevice()`. This is a quiet safety net, not a designed-around path.

**Deleted:** `apps/mobile/src/screens/approvals/components/ApproverSetupSheet.tsx` and the wiring added to `SettingsSheet.tsx`. `registerApproverDevice()` in `services/approverDevice.ts` loses its `password` and `pin` parameters and is called only by `ensureApproverDevice()`.

## 5. Assurance ladder — PIN removed

The risk→tier mapping is unchanged. Only the L3/L4 factors change.

| Tier | Level | Required (after) |
|---|---|---|
| low | **L1** | session tap (app biometric-opened / live console) — unchanged |
| medium | **L2** | fresh biometric-gated signature over `{approvalId, nonce}` — unchanged |
| high | **L3** | L2 **+ recency check** (no PIN) |
| critical | **L4** | L3 **+ hardware/platform-bound key + fresh account re-authentication** (no PIN) |

**Why the PIN goes:**
- The anti-fatigue / request-binding job is already done by the L2 signature over `{approvalId, nonce}` plus on-device display of the request details — a blind or wrong-request approval is cryptographically impossible. A static PIN adds nothing here.
- As a pure second factor, a 4–6 digit static PIN is the weakest element (shoulder-surfable, reused, phishable) and sits *behind* a Face ID that already proved a trusted device + the holder. Its only real value was the narrow "stolen *unlocked* phone with biometric access" edge.
- A PIN to set and type re-introduces exactly the friction this redesign removes.

**L3 recency:** the L2 signature is inherently fresh (per-request nonce, short TTL). "Recency" for L3 therefore means the approval-assertion challenge must be consumed within its TTL — proposed **120s** (matches the approval-decision window already used for the Redis challenge `approval-assertion:{approvalId}:{userId}`). No new factor, just a tighter window enforced server-side.

**L4 re-auth:** at a critical approval, after the biometric signature, the surface requires a **fresh account re-authentication** — re-enter the account password, or satisfy login-MFA if the account has it. Inline on both phone and browser. This is a genuine knowledge/possession factor stronger than a static PIN, with nothing to set up. The server records it on the decision (`reauth_at` / reuse existing audit fields) and `assertApprovalAssurance` requires it for `riskTier='critical'`.

## 6. Surfaces

**Mobile:** no setup screen. Optionally, Settings shows a read-only "This phone can approve high-risk actions ✓" status line (informational, not an action). Revoke happens server-side / from the web like other paired devices.

**Web "Approval security" panel** (`apps/web/src/components/settings/ApproverDevicesSection.tsx`):
- **Lists all registered approver devices for the user**, including auto-registered phones (`kind='mobile_hw_key'`) and any registered browsers (`kind='webauthn_platform'`), with platform, label, last-used, and revoke.
- Keeps the **optional** "Register this browser with Windows Hello / Touch ID" action below the list — unchanged mechanism, reframed as additive.
- The empty state changes from "no devices, register this browser" to reflect that a logged-in phone should already appear; if none, hint to open the mobile app.

## 7. Data model & server changes

**Keep:** `authenticator_devices` table, `authenticator_policies`, the `decided_via`/`decided_assurance_level` columns on `approval_requests`/`elevation_requests`, the `assertApprovalAssurance` guard, `assuranceLevel.ts` resolver.

**Remove (PIN):**
- `apps/api/src/routes/auth/pin.ts` (+ test) and `apps/api/src/services/pin.ts` (+ test).
- Approver-PIN columns on `users` (schema migration — additive *drop*, idempotent).
- `pin_verified` column on `approval_requests` / `elevation_requests` (or retain as always-false/deprecated if a drop is risky on the shared dev DB — implementation plan decides).
- PIN validators in `packages/shared/src/validators/authenticator.ts`.
- PIN branches in `authenticatorAssurance.ts`, `approvals.ts`, `pam.ts`.

**Change:**
- `authenticatorAssurance.ts`: L3 = signature + recency (TTL) verified; L4 = signature + `is_platform_bound` device + fresh re-auth assertion; PIN logic deleted.
- `routes/authenticator.ts`: registration endpoint no longer requires a password step-up body; activation moves to first-signature PoP.
- Mobile `services/approverDevice.ts`: drop password/PIN params; add `ensureApproverDevice()` idempotent provisioning.

**Migrations** follow repo rules: idempotent, date-prefixed, never edit a shipped one. Since #1369 is unmerged, its PIN-adding migration(s) should be **edited/folded out before merge** rather than added-then-dropped (acceptable only because #1369 hasn't shipped — verify no environment has applied them; the shared dev DB has, so a forward drop migration may still be needed).

## 8. What this reverts from #1369

Because #1369 is unmerged, fold this redesign *into* that branch rather than merge-then-rework:
- Delete `ApproverSetupSheet.tsx` + the `SettingsSheet.tsx` wiring (the change added during this session).
- Remove the PIN feature surface (Phase 3's PIN service, routes, columns, validators, tests).
- Rework Phase 1 registration migration/endpoint to the login-triggered model.
- Update Phase 4 enforcement to the new L3/L4 factors.

## 9. Sequencing

1. Land this spec → implementation plan.
2. Apply the redesign on the `feat/breeze-authenticator-step-up` branch (#1369), revising the relevant phase commits.
3. Re-run the full authenticator test suite + RLS forge; verify on a physical device that login alone makes the phone appear at `/settings/profile` and that a real approval is the first biometric.
4. Then merge #1369.

## 10. Testing

- **Unit:** `ensureApproverDevice()` idempotency (no-op when active key exists); registration without password; `assuranceLevel` unchanged; `authenticatorAssurance` L3 recency + L4 re-auth, PIN paths gone.
- **Mobile (pure-logic vitest):** provisioning trigger fires on `loginAsync.fulfilled` and on restored-session `setCredentials`; not on logout.
- **RLS:** `authenticator_devices` forge tests unchanged (still pass).
- **On-device (CI-blind, manual):** fresh login → phone auto-appears as an approver on the web with no in-app setup; first approval is the first Face ID; critical approval prompts re-auth; key is non-exportable; `decided_via='mobile_hw_key'`.

## 11. Resolved questions

- Browser stays an **optional** approver (not removed).
- **No PIN**; L4 uses fresh account re-auth.
- L3 recency = the existing ~120s challenge TTL.
- L4 re-auth surface = inline account password / login-MFA on phone and browser.
