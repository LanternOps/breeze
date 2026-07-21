# Breeze Authenticator — risk-tiered step-up verification for approvals

**Status:** Draft (design) · **Date:** 2026-06-14 · **Author:** Todd + Claude
**Related:** #1254 (mobile approval bridge — first consumer), Discussion #858 (PAM), existing login MFA (`routes/auth/passkeys.ts`, `services/passkeys.ts`)

---

## 1. Problem

Today an approval (PAM elevation, AI tool action, helper/MCP step-up) is decided by a **logged-in session** — `POST /api/v1/mobile/approvals/:id/approve` and `POST /pam/elevation-requests/:id/respond` just trust the bearer token. The mobile app prompts Face ID before the tap, but that biometric is **device-local and never reaches the server** (`apps/mobile/.../ApprovalButtons.tsx`); the API gates on nothing more than "this user is authenticated."

That is too weak for the actions Breeze is about to let technicians approve from a phone — privileged Windows elevation and Tier-4 AI actions. A stolen/unlocked session, a left-open browser, or push-fatigue tapping can approve a privileged action with no proof that the *right human on a trusted device* deliberately authorized *this specific request*.

We want a **Breeze Authenticator**: the technician registers a trusted device once (Microsoft-Authenticator style), and from then on approvals require a verification whose **strength scales with the action's risk tier**, enforced **server-side**.

## 2. Goals / non-goals

**Goals**
- A registered, **device-bound, biometric-gated signing key** per technician device — works on **both** the mobile app and the browser/desktop.
- A **risk-tiered assurance ladder** keyed off the `approval_requests.riskTier` enum (`low|medium|high|critical`) that already exists on every approval.
- **Server-side enforcement** on the decide endpoints: medium+ approvals must present a verifiable signature; high+ adds a server-verified **PIN**.
- A **per-partner policy** to raise the required rung above the Breeze floor (never below).
- **Factor recording**: every decision records *which device, which assurance level, PIN-verified or not*.
- Backward compatible: if no authenticator is enrolled and policy demands only L1, behavior is exactly today's — so **#1254 is never blocked**.

**Non-goals (YAGNI)**
- Number-matching (rejected — assumes co-location with the originating screen; breaks "approve from anywhere"). PIN replaces it.
- End-user (non-technician) self-elevation identity. Out of scope; this is a *technician/approver* feature.
- Replacing login MFA. Login passkeys/TOTP stay as-is; approver devices are a **separate registration** (a device may hold both).
- Desktop Breeze Helper as an approval surface (possible future; web + mobile only now).
- TOTP/SMS as an approval factor (knowledge/possession already covered by PIN + device key).

## 3. Concepts

- **Authenticator device** — a registered, device-bound key belonging to one technician. Two `kind`s, identical role:
  - `mobile_hw_key` — hardware keypair in iOS Secure Enclave / Android Keystore, generated in-app (`react-native-biometrics`), biometric-gated, non-exportable, non-syncable.
  - `webauthn_platform` — a WebAuthn **platform** credential (Windows Hello / Touch ID), registered as an *approver* credential via the shipped `@simplewebauthn` path.
- **Assurance level (L1–L4)** — the verification strength demanded of a decision.
- **Required assurance** — pure function `requiredAssurance(riskTier, partnerPolicy) → L1..L4`.
- **Approver PIN** — one per technician (something-you-know), set at first authenticator registration, **verified server-side**.
- **Assertion challenge** — a one-time, short-TTL server nonce bound to `{approvalId, requiredLevel}`; the device signs it; replay-protected.

## 4. The assurance ladder

`requiredAssurance` maps each approval's `riskTier` to a floor; partner policy may raise a rung.

| riskTier | Example | Required assurance | Phone (registered app) | Browser (registered Hello/Touch ID) |
|---|---|---|---|---|
| **low** | approve a user app-install | **L1** | app already opened with biometric → **tap** | active console session → **click** |
| **medium** | routine PAM elevation, Tier-2 AI | **L2** | push → **fresh biometric** signs challenge | **fresh Hello/Touch ID** assertion |
| **high** | sensitive elevation, Tier-3 AI | **L3** | biometric sign **+ PIN** | Hello/Touch ID **+ PIN** |
| **critical** | Tier-4 AI, destructive/blocklist override | **L4** | L3 **+ platform/hardware-only key** (no synced/roaming), recency check | L3 **+ platform credential only** |

- **L1** relies on the app-open biometric (mobile) or live session (browser) — no fresh signature, no redundant re-prompt. This is today's behavior, so unconfigured tenants and #1254 keep working.
- **L2** = a fresh, biometric-gated **signature over the challenge** from a registered device. The signing operation itself triggers the OS biometric prompt.
- **L3** = L2 **+** the server-verified PIN (knowledge factor; works anywhere, replaces number-matching).
- **L4** = L3 **+** the device must be **platform/hardware-bound** (synced/roaming credentials are rejected for critical) **+** a registration-recency check.

Request-binding is preserved without number-matching: the request detail (user / exe / machine) is shown on the device, and the signature is over `{approvalId, nonce}`, cryptographically pinning the decision to that exact request.

## 5. Architecture overview

```
                         ┌──────────────────────────────────────────┐
   approval created      │  approval_requests row (riskTier set)     │
   (#1254 / AI / helper) │  requiredAssurance(riskTier, partnerPol.) │
                         └──────────────┬───────────────────────────┘
                                        │ push (Expo) / console badge
                 ┌──────────────────────┴───────────────────────┐
                 ▼                                               ▼
       Phone (mobile_hw_key)                          Browser (webauthn_platform)
   1. POST /approvals/:id/assertion-challenge      1. POST /approvals/:id/assertion-challenge
      → {challenge,nonce,requiredLevel,summary}       → {challenge, allowCredentials,…}
   2. biometric-unlock key → sign(nonce)           2. navigator.credentials.get(...) (Hello)
   3. if L3+: collect PIN                           3. if L3+: collect PIN
   4. POST /approvals/:id/approve { proof }         4. POST /approvals/:id/approve { proof }
                 └───────────────────────┬───────────────────────┘
                                         ▼
                        assertApprovalAssurance(approval, proof)
                  verify signature vs authenticator_devices.public_key
                  verify nonce fresh + one-time (Redis) + bound to approvalId
                  if L3+: verify argon2(pin) + rate-limit/lockout
                  if L4 : require is_platform_bound + recency
                                         ▼
                  CAS decide (existing) + record factor columns + audit
```

The enforcement is a single guard, `assertApprovalAssurance`, called by **every** decide path so PAM, AI, mobile, and helper approvals are uniformly gated.

## 6. Data model

### 6.1 `authenticator_devices` (new) — Shape 6 (user-id scoped)

```
id                 uuid pk
user_id            uuid not null  → users(id) on delete cascade
kind               authenticator_kind  ('mobile_hw_key' | 'webauthn_platform')
label              varchar(255)        -- "Todd's iPhone 15", "Work laptop (Hello)"
public_key         text not null       -- mobile: SPKI/raw EC pubkey; web: COSE key
credential_id      text                -- web only, unique; null for mobile
sign_count         integer not null default 0   -- anti-clone counter (web) / monotonic (mobile)
aaguid             text                -- web only
transports         jsonb               -- web only
is_platform_bound  boolean not null    -- true = non-syncable hardware (L4-eligible)
mobile_device_id   uuid                -- optional → mobile_devices(id); null for web
created_at         timestamptz default now() not null
last_used_at       timestamptz
disabled_at        timestamptz
disabled_reason    text
```
RLS mirrors `user_passkeys` exactly (`2026-06-11-j-user-passkeys.sql`):
```sql
ALTER TABLE authenticator_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE authenticator_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY authenticator_devices_user_scope ON authenticator_devices
  FOR ALL
  USING     (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system')
  WITH CHECK (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system');
```
Add `'authenticator_devices'` to `USER_ID_SCOPED_TABLES` in `rls-coverage.integration.test.ts` (same PR).

### 6.2 Approver PIN — columns on `users` (alongside existing MFA fields)

```
approver_pin_hash         text          -- argon2id; null until set
approver_pin_set_at       timestamptz
approver_pin_failed_count integer not null default 0
approver_pin_locked_until timestamptz
```
On `users` (already dual-axis RLS, Shape 4). The PIN is per-technician, surface-independent.

### 6.3 `authenticator_policies` (new) — Shape 3 (partner-axis)

```
partner_id     uuid pk  → partners(id) on delete cascade   -- one policy row per MSP
floor_overrides jsonb not null default '{}'  -- { "low":"L1","medium":"L2","high":"L3","critical":"L4" } raises only
require_enrollment boolean not null default false  -- techs must enroll an authenticator to approve > L1
enforce_from   timestamptz                   -- grace window before enforcement
updated_by_user_id uuid → users(id)
updated_at     timestamptz default now() not null
```
RLS: `breeze_has_partner_access(partner_id)` (flat, never tree traversal); add `'authenticator_policies' → 'partner_id'` to the `PARTNER_TENANT_TABLES` map in `rls-coverage.integration.test.ts`. The MSP sets its own approval posture; Breeze ships the default floor and `floor_overrides` may only **raise** a rung (validated app-side and re-checked server-side). Org-level override is a documented future extension, not in v1.

### 6.4 Factor recording

On `approval_requests` (the unified surface):
```
decided_assurance_level   smallint        -- 1..4 actually enforced
decided_via               approval_factor ('session_tap'|'mobile_hw_key'|'webauthn_platform')
authenticator_device_id   uuid            -- → authenticator_devices(id), null for session_tap
pin_verified              boolean not null default false
```
Mirror the same four onto `elevation_requests` for PAM `respond` paths that decide directly (not via a `parentApprovalId`). The existing `elevation_audit` gains an `assurance_level` + `factor` in its `details` JSONB (no schema change needed there).

### 6.5 Challenge store

No table — reuse the existing Redis challenge pattern (`services/passkeys.ts` stores WebAuthn challenges in Redis, 5-min TTL). Key: `approval-assertion:{approvalId}:{userId}` → `{nonce, requiredLevel, issuedAt}`, single-use (deleted on successful verify), short TTL (e.g. 120s to match the approval-decision window).

## 7. Registration flows

All registration is **step-up gated** by the existing `requireCurrentPasswordStepUp()` (`routes/auth/helpers.ts:76`), same as login-passkey setup.

### 7.1 Phone (`mobile_hw_key`)
1. App calls `react-native-biometrics.createKeys()` → hardware keypair (biometric ACL), returns public key.
2. `POST /api/v1/authenticator/devices` `{kind:'mobile_hw_key', publicKey, label, mobileDeviceId, isPlatformBound:true}` (password step-up). Server stores the row.
3. Server issues a **proof-of-possession challenge**; app signs it with the new key; server verifies before marking the device `active`. (Prevents registering a bogus public key.)
4. If the user has no `approver_pin_hash`, prompt to set the PIN now (`POST /api/v1/authenticator/pin`, argon2id server-side).

### 7.2 Browser (`webauthn_platform`)
1. `POST /api/v1/authenticator/devices/webauthn/options` → `generateRegistrationOptions` with `authenticatorAttachment:'platform'`, `residentKey:'preferred'`, `userVerification:'required'` (reuse `services/passkeys.ts`).
2. `navigator.credentials.create(...)` (Windows Hello / Touch ID).
3. `POST /api/v1/authenticator/devices/webauthn/verify` → `verifyRegistration`; store as `authenticator_devices` row with `kind:'webauthn_platform'`, `is_platform_bound` = `(deviceType === 'singleDevice' && !backedUp)`.
4. PIN set as above if not present.

> Approver credentials live in the **new** table, not `user_passkeys`, so "login passkey" and "approver device" stay conceptually distinct even when backed by the same authenticator. The verification *service* (`verifyPasskeyAuthentication`) is reused against the stored credential.

## 8. Approval / challenge / sign / verify flow

1. **Challenge:** `POST /api/v1/approvals/:id/assertion-challenge`
   - Server loads the approval, computes `requiredAssurance(riskTier, partnerPolicy)`.
   - If **L1**: returns `{requiredLevel:1}` and the client may approve directly (no proof) — backward-compatible path.
   - Else: generates `nonce`, stores `{nonce, requiredLevel}` in Redis, returns `{requiredLevel, nonce, requestSummary, allowCredentials?}`.
2. **Sign (client):**
   - Mobile: `createSignature({payload: nonce})` → biometric prompt → signature.
   - Browser: `navigator.credentials.get({challenge: nonce, allowCredentials})` → assertion.
   - If `requiredLevel ≥ 3`: collect PIN.
3. **Decide:** `POST /api/v1/approvals/:id/approve` (and `/deny`, `/pam/elevation-requests/:id/respond`) with
   `{decision, proof:{authenticatorDeviceId, signature|assertion, signedNonce, pin?}}`.
4. **`assertApprovalAssurance` (server):**
   - Recompute `requiredAssurance` (never trust client-sent level).
   - Verify the nonce exists in Redis, matches this approval, not yet consumed; **delete it** (one-time).
   - Verify the signature/assertion against `authenticator_devices.public_key`; bump `sign_count` (reject non-incrementing for web — anti-clone).
   - If `≥ L3`: verify `argon2.verify(approver_pin_hash, pin)`; on failure bump `approver_pin_failed_count`, lock after N (e.g. 5) via `approver_pin_locked_until`; never log the PIN.
   - If `≥ L4`: require `is_platform_bound = true` and `created_at` within the recency window (e.g. ≤ 90 days) else 412.
   - On success: proceed to the **existing CAS decide** logic; write the factor-recording columns; `last_used_at = now()`.
5. **Failure modes:** missing/invalid proof when `requiredLevel>1` → `401 step_up_required` with the `requiredLevel` so the client can drive the right flow; expired nonce → `409 challenge_expired`; PIN locked → `423 pin_locked`.

## 9. Enforcement hook & required-assurance resolution

- `requiredAssurance(riskTier, partnerPolicy)` — pure, unit-tested, in `packages/shared` (shared with the apps for client-side UX hints; **server re-evaluates** authoritatively).
- `assertApprovalAssurance(c, approval, proof)` — one guard in `apps/api/src/services/authenticatorAssurance.ts`, called by:
  - `approvalRoutes.post('/:id/approve' | '/:id/deny')` (`routes/approvals.ts:146`)
  - `pam.ts` `'/elevation-requests/:id/respond'` (`routes/pam.ts:292`)
  - any future decide path (AI tool resolution, helper step-up).
- **Deny** requires the same assurance as approve at L2+ (a deny is a security-relevant decision too) — but never blocks a deny on a *locked PIN* (fail-safe: a tech must always be able to deny; if PIN is locked, allow deny at L2 with a flag). This avoids a denial-of-service on the safe action.

## 10. Policy model

- Breeze ships the **default floor** (§4). Partners may **raise** any rung via `authenticator_policies.floor_overrides`; lowering is rejected.
- `require_enrollment` + `enforce_from` give a grace window: before `enforce_from`, an un-enrolled tech may still approve L2+ on session alone (logged + audited as `assurance_downgraded_grace`); after, L2+ without a registered device is refused with a "set up your authenticator" prompt.
- Surfaced in the existing PAM/security admin UI (a new "Approval security" tab) — read/write gated by an admin permission (reuse `requirePamWrite`-style or a new `requireSecurityAdmin`).

## 11. Recovery & lifecycle

- **Lost phone:** revoke via `mobileDevices` soft-block (exists) → cascade-disable its `authenticator_devices` row (`disabled_at`). Re-pair issues a fresh device + new key. No key ever leaves the device, so a lost phone exposes nothing.
- **PIN reset:** `requireCurrentPasswordStepUp` + (if enrolled) a successful signature from a *still-valid* device, OR an admin-initiated reset that forces re-enrollment. Resets clear `approver_pin_failed_count`/`locked_until`.
- **Device revocation (admin):** a partner admin can disable a tech's authenticator device(s) (e.g. offboarding) — sets `disabled_at`, audited.
- **All devices lost / no valid factor:** falls to admin reset → re-enroll; high/critical approvals are unavailable to that tech until re-enrolled (correct fail-closed posture).

## 12. Security considerations

- **Replay:** one-time Redis nonce bound to `{approvalId, userId}`, short TTL, deleted on use. Signature is over the nonce, so a captured request can't be replayed against another approval.
- **PIN over the wire:** sent inside the authenticated TLS session, only at L3+, argon2id-verified, rate-limited + lockout, never logged. It is an *additive* factor on top of device possession + biometric, not a sole gate.
- **Client-asserted biometric:** at L1 we trust the app-open biometric (low risk only). At L2+ the biometric is *not* trusted as a claim — it gates the **hardware signing operation**, so a valid signature is itself evidence the biometric cleared on a non-exportable key.
- **Synced/roaming keys:** WebAuthn passkeys can sync (iCloud Keychain). `is_platform_bound` is computed at registration; **critical (L4) rejects non-platform-bound** devices, preserving "one trusted device."
- **Sign-count anti-clone** for web credentials (existing `verifyPasskeyAuthentication` behavior); monotonic counter optional for mobile.
- **Deny fail-safe:** never let a locked PIN or missing device block a *deny*.
- **Audit:** every decision records device + assurance + pin_verified; grace-window downgrades are explicitly flagged in `elevation_audit`/approval audit.
- **RLS:** new tables follow Shapes 6/3 with policies in the creating migration + allowlist + contract test (per CLAUDE.md). `mobile_hw_key` registration must verify proof-of-possession before activation (no attacker-supplied public keys).

## 13. Relationship to #1254 & existing MFA

- **#1254** writes `approval_requests` rows with a `riskTier` (via `pamBridge`) and pushes them. It is the **first consumer** and needs no change to ship: until policy demands >L1 or the tech enrolls, the decide path is today's. The authenticator layers on top.
- **Login MFA** (passkeys/TOTP/SMS) is untouched. Approver devices are a distinct registration in a distinct table; a single physical authenticator may serve both roles.

## 14. Testing approach

- **Shared:** unit tests for `requiredAssurance(riskTier, policy)` incl. floor-raise validation and lower-rejection (Vitest, `packages/shared`).
- **API unit:** `assertApprovalAssurance` table-driven — each level's accept/reject, nonce reuse → reject, bad signature → reject, sign-count regression → reject, PIN wrong → lockout after N, L4 non-platform-bound → 412, deny-with-locked-PIN → allowed. Drizzle-mock per `breeze-testing` skill.
- **RLS:** forge cross-tenant insert/select on `authenticator_devices` (Shape 6) and `authenticator_policies` (Shape 3) as `breeze_app` — must fail; add both to the coverage contract test. (Heed the worktree `.env.test` / non-memoized-fixture lessons.)
- **Registration:** proof-of-possession round-trip for `mobile_hw_key`; WebAuthn register/verify for `webauthn_platform` (`is_platform_bound` derivation).
- **Integration:** end-to-end challenge → sign → approve for both surfaces against a real DB; grace-window downgrade path.
- **Mobile (Detox/unit):** keypair create + biometric sign happy path and biometric-cancel.
- **Manual:** real iOS Secure Enclave + Android Keystore signing; Windows Hello + Touch ID in-browser. (Mobile hardware is CI-blind, like #1000 for the agent — gate manually.)

## 15. Rollout / phasing

1. **Phase 1 — foundation:** `authenticator_devices` + users PIN columns + `authenticator_policies` (migrations, RLS, allowlists, contract test). `requiredAssurance` in shared. `assertApprovalAssurance` guard returning L1-passthrough only (no behavior change). Factor-recording columns. *Ships dark, default floor = today.*
2. **Phase 2 — browser approver:** WebAuthn approver registration + assertion verify on the decide path (L2/L3). Admin "Approval security" tab. Web console approve-with-Hello.
3. **Phase 3 — mobile authenticator:** RN hardware keypair register + biometric sign; push-to-approve wired to #1254; PIN flow.
4. **Phase 4 — critical hardening:** L4 platform-bound + recency, partner policy raise-the-floor enforcement + grace window, recovery/offboarding flows.

Each phase is independently shippable; nothing is user-visible until a partner raises a rung or a tech enrolls.

## 16. Open questions / future

- **Org-level (not just partner) policy override** — deferred; partner floor only in v1.
- **Desktop Breeze Helper as an approval surface** — possible Phase 5.
- **Number-matching for the rare co-located/in-console case** — dropped; revisit only if a concrete need appears.
- **End-user self-service elevation identity** — separate feature, out of scope.
- **Shared device for login + approver credential** — allowed; do we ever want to *force* distinct authenticators? Default: allow shared.
