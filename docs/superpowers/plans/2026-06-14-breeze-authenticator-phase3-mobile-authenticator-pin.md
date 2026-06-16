# Breeze Authenticator — Phase 3 (Mobile Authenticator + PIN/L3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the **mobile hardware-key authenticator** (biometric-gated Secure-Enclave/Keystore signing) and the **server-verified approver PIN (L3)** to the approval flow — verified server-side and recorded — still **non-blocking** (enforcement is Phase 4).

**Architecture:** Mobile keys are NOT WebAuthn — they're a raw keypair (`react-native-biometrics`: `createKeys` → SPKI public key, `createSignature` → RSA-SHA256 base64 signature over a server nonce). The server verifies with node `crypto.verify` against the stored public key. PIN reuses the shipped argon2 (`services/password.ts`) over the P1 `users.approver_pin_*` columns, with lockout. `assertApprovalAssurance` gains a `mobile_hw_key` branch (→ L2) and an additive PIN check (→ L3, `pinVerified=true`). The mobile app signs behind a `HardwareSigner` interface; the `react-native-biometrics` adapter is thin and flagged for on-device verification.

**Tech Stack:** TypeScript, Hono, Drizzle, node `crypto`, argon2, React Native (Expo), Vitest. Node v22.20.0.

**Spec:** `.../2026-06-14-breeze-authenticator-step-up-approvals-design.md` (§6.2 PIN, §7.1 mobile registration, §8.2-8.3 sign/verify, §9 guard). Builds on P1 (PR #1369) + P2.

**No DB migration** — P1 shipped `authenticator_devices` (`kind='mobile_hw_key'`), the `users.approver_pin_*` columns, and the factor columns.

**Scope split (be explicit):**
- **Verifiable in CI/sandbox (server + mobile JS):** Tasks 1-9 below. The mobile signature contract is proven with **node-generated RSA test vectors** (sign a nonce with node `crypto` exactly as the device will, verify server-side) — no device needed.
- **MANUAL / on-device only (CI-blind, like agent #1000):** adding `react-native-biometrics` as a native dep (config plugin + Expo dev client), the real Secure-Enclave `createKeys`/`createSignature`, and an end-to-end register→approve on a physical iPhone + Android. Listed in the "Manual handoff" section; the `HardwareSigner` adapter is the only un-unit-tested file.
- Every command: `cd /Users/toddhebebrand/breeze-worktrees/authenticator-phase1` · `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. Mobile tests: `pnpm --filter @breeze/mobile exec vitest run <file>` (confirm the mobile package name + test runner in apps/mobile/package.json first; if it uses jest, use that). Known tsc noise: agents.test.ts, apiKeyAuth.test.ts, validators/ticketConfig.test.ts.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/pin.ts` (create) | `setApproverPin`, `verifyPinAttempt` (argon2 reuse + lockout over the P1 columns) |
| `apps/api/src/services/mobileHwKey.ts` (create) | Registration + assertion nonce helpers (Redis) + `verifyMobileSignature` (node `crypto.verify`, SPKI key) |
| `apps/api/src/routes/auth/pin.ts` (create) | `PUT /auth/pin` (set, password step-up), `POST /auth/pin/verify` |
| `apps/api/src/routes/authenticator.ts` (modify) | `POST /authenticator/devices/mobile-hw-key/{options,verify}` |
| `packages/shared/src/validators/authenticator.ts` (modify) | Add `mobileHwKeyProofSchema` + a discriminated `approvalProofSchema`; add `approverPinSchema` |
| `apps/api/src/services/authenticatorAssurance.ts` (modify) | `mobile_hw_key` branch (→L2) + additive PIN check (→L3) |
| `apps/api/src/routes/approvals.ts` (modify) | challenge returns a mobile nonce when caller has `mobile_hw_key` devices; thread mobile proof + `pin` |
| `apps/api/src/routes/pam.ts` (modify) | same for `respond` |
| `apps/mobile/src/services/hardwareSigner.ts` (create) | `HardwareSigner` interface + `react-native-biometrics` adapter (**native; manual-verify**) + a `nullSigner` |
| `apps/mobile/src/services/approverDevice.ts` (create) | register mobile_hw_key, get+sign an approval challenge, PIN set/verify API calls |
| `apps/mobile/src/screens/approvals/components/ApprovalButtons.tsx` (modify) | sign the challenge on approve; PIN entry for high/critical |
| `apps/mobile/src/screens/settings/*` (create/modify) | "Approver setup": register device + set PIN |

---

## Task 1: PIN service (argon2 reuse + lockout)

**Files:** Create `apps/api/src/services/pin.ts`, `apps/api/src/services/pin.test.ts`.

Reuse `hashPassword`/`verifyPassword` from `services/password.ts` (recon-confirmed argon2id, 64MB/3/4). Columns (P1): `approverPinHash`, `approverPinSetAt`, `approverPinFailedCount`, `approverPinLockedUntil`.

- [ ] **Step 1: Write failing tests** — `setApproverPin(userId, pin)` hashes + stores + resets failed count; `verifyPinAttempt(userId, pin)` returns `{verified:true}` on match (resets count); on mismatch increments `approverPinFailedCount`, and at ≥5 sets `approverPinLockedUntil = now+15m` and returns `{verified:false, locked:true}`; a locked account returns `{verified:false, locked:true}` without checking. Use the `../db` chainable mock (mirror `aiCostTracker.test.ts`).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** `services/pin.ts`:

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { hashPassword, verifyPassword } from './password';

const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60_000;

export async function setApproverPin(userId: string, pin: string): Promise<void> {
  const approverPinHash = await hashPassword(pin);
  await db.update(users).set({
    approverPinHash,
    approverPinSetAt: new Date(),
    approverPinFailedCount: 0,
    approverPinLockedUntil: null,
  }).where(eq(users.id, userId));
}

export async function verifyPinAttempt(userId: string, pin: string): Promise<{ verified: boolean; locked: boolean }> {
  const [u] = await db.select({
    hash: users.approverPinHash,
    failed: users.approverPinFailedCount,
    lockedUntil: users.approverPinLockedUntil,
  }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u || !u.hash) return { verified: false, locked: false };
  if (u.lockedUntil && u.lockedUntil > new Date()) return { verified: false, locked: true };

  const ok = await verifyPassword(u.hash, pin);
  if (ok) {
    await db.update(users).set({ approverPinFailedCount: 0, approverPinLockedUntil: null }).where(eq(users.id, userId));
    return { verified: true, locked: false };
  }
  const failed = (u.failed ?? 0) + 1;
  const locked = failed >= MAX_PIN_ATTEMPTS;
  await db.update(users).set({
    approverPinFailedCount: failed,
    approverPinLockedUntil: locked ? new Date(Date.now() + LOCKOUT_MS) : null,
  }).where(eq(users.id, userId));
  return { verified: false, locked };
}
```

- [ ] **Step 4: Run — PASS.** Typecheck. **Step 5: Commit** — `feat(api): approver PIN service (argon2 + lockout)`.

---

## Task 2: PIN endpoints

**Files:** Create `apps/api/src/routes/auth/pin.ts` + test; mount in the auth router (match where `routes/auth/passkeys.ts` is mounted).

- [ ] **Step 1: Failing tests** — `PUT /auth/pin` requires password step-up (`requireCurrentPasswordStepUp`, reuse from `routes/auth/helpers.ts`), validates a 4-6 digit numeric PIN (`approverPinSchema`), calls `setApproverPin`, audits `auth.pin.set`; rejects a weak/non-numeric PIN (400). `POST /auth/pin/verify` calls `verifyPinAttempt`, returns `{verified, locked}` (no approval side-effect).

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** the router; add `approverPinSchema = z.string().regex(/^\d{4,6}$/)` to `packages/shared/src/validators/authenticator.ts`. **Step 4: PASS** + typecheck. **Step 5: Commit** — `feat(api): PIN set/verify endpoints`.

---

## Task 3: Mobile-hw-key crypto service (the verifiable core)

**Files:** Create `apps/api/src/services/mobileHwKey.ts` + test.

This is the cryptographic contract. Verified with **node-generated RSA test vectors** — no device.

- [ ] **Step 1: Write failing tests** using real node keys:

```ts
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { verifyMobileSignature } from './mobileHwKey';

function makeDeviceKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { spkiB64, privateKey };
}
function sign(privateKey: crypto.KeyObject, payload: string) {
  return crypto.sign('RSA-SHA256', Buffer.from(payload, 'utf8'), privateKey).toString('base64');
}

describe('verifyMobileSignature', () => {
  it('verifies a genuine RSA-SHA256 signature over the nonce (the react-native-biometrics contract)', () => {
    const { spkiB64, privateKey } = makeDeviceKeypair();
    const nonce = 'server-nonce-abc';
    const signature = sign(privateKey, nonce);
    expect(verifyMobileSignature({ publicKeySpkiB64: spkiB64, payload: nonce, signatureB64: signature })).toBe(true);
  });
  it('rejects a signature over a different nonce (replay/forgery)', () => {
    const { spkiB64, privateKey } = makeDeviceKeypair();
    const signature = sign(privateKey, 'other-nonce');
    expect(verifyMobileSignature({ publicKeySpkiB64: spkiB64, payload: 'server-nonce-abc', signatureB64: signature })).toBe(false);
  });
  it('rejects a signature from a different key', () => {
    const a = makeDeviceKeypair(); const b = makeDeviceKeypair();
    const signature = sign(b.privateKey, 'n');
    expect(verifyMobileSignature({ publicKeySpkiB64: a.spkiB64, payload: 'n', signatureB64: signature })).toBe(false);
  });
});
// + tests for the Redis nonce helpers (mock redis like passkeys.test.ts): issue stores a 32-byte base64url nonce at
//   mobile-assertion:<approvalId>:<userId> (120s) / mobile-reg:<userId> (300s); consume is getdel single-use.
```

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** `services/mobileHwKey.ts`:

```ts
import crypto from 'node:crypto';
import { getRedis } from './redis'; // match the import used by approverWebAuthn.ts

const ASSERTION_TTL = 120;
const REG_TTL = 300;
const regKey = (userId: string) => `mobile-reg:${userId}`;
const assertionKey = (approvalId: string, userId: string) => `mobile-assertion:${approvalId}:${userId}`;

/** Verify an RSA-SHA256 signature (PKCS#1 v1.5) over `payload` against an SPKI DER public key (base64).
 *  This is exactly what react-native-biometrics produces. Returns false on any malformed input (never throws). */
export function verifyMobileSignature(input: { publicKeySpkiB64: string; payload: string; signatureB64: string }): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(input.publicKeySpkiB64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify('RSA-SHA256', Buffer.from(input.payload, 'utf8'), key, Buffer.from(input.signatureB64, 'base64'));
  } catch {
    return false;
  }
}

async function issueNonce(key: string, ttl: number): Promise<string> {
  const nonce = crypto.randomBytes(32).toString('base64url');
  const redis = getRedis();
  if (!redis) throw new Error('redis unavailable');
  await redis.setex(key, ttl, nonce);
  return nonce;
}
async function consumeNonce(key: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) throw new Error('redis unavailable');
  return redis.getdel(key);
}

export const issueMobileRegistrationNonce = (userId: string) => issueNonce(regKey(userId), REG_TTL);
export const consumeMobileRegistrationNonce = (userId: string) => consumeNonce(regKey(userId));
export const issueMobileAssertionNonce = (approvalId: string, userId: string) => issueNonce(assertionKey(approvalId, userId), ASSERTION_TTL);
export const consumeMobileAssertionNonce = (approvalId: string, userId: string) => consumeNonce(assertionKey(approvalId, userId));
```

- [ ] **Step 4: PASS** + typecheck. **Step 5: Commit** — `feat(api): mobile hardware-key signature verify + nonce helpers`.

---

## Task 4: Mobile-hw-key registration routes

**Files:** Modify `apps/api/src/routes/authenticator.ts` + test.

- [ ] **Step 1: Failing tests** — `POST /authenticator/devices/mobile-hw-key/options` (password step-up) returns `{nonce}` and stores it; `/verify` with `{publicKey, signature, label}` verifies the proof-of-possession (`verifyMobileSignature` over the consumed nonce), then INSERTs `authenticator_devices` (`kind:'mobile_hw_key'`, `publicKey`, `credentialId:null`, `signCount:0`, `isPlatformBound:true`, `mobileDeviceId` from the `X-Breeze-Mobile-Device-Id` header if present); a bad PoP signature → 400, no insert.

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** mirroring the P2 webauthn register routes (same password step-up + audit `auth.authenticator.device.register`), but using the Task 3 nonce + `verifyMobileSignature`. **Step 4: PASS** + typecheck. **Step 5: Commit** — `feat(api): mobile-hw-key device registration routes`.

---

## Task 5: Shared proof union + mobile nonce on the challenge

**Files:** Modify `packages/shared/src/validators/authenticator.ts` (+test), `apps/api/src/routes/approvals.ts` (+test).

- [ ] **Step 1: Failing tests** — `approvalProofSchema` accepts EITHER the P2 webauthn proof OR `mobileHwKeyProofSchema = { type:'mobile_hw_key', credentialId, nonce, signature }`; an optional `pin` field rides alongside. `POST /approvals/:id/assertion-challenge` returns `{ webauthn?: <options>, mobileNonce?: <string> }` — `mobileNonce` present iff the caller has an active `mobile_hw_key` device (issues `issueMobileAssertionNonce`).

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** Keep P2's `assertionProofSchema` as the webauthn variant; add the mobile variant + a discriminated `approvalProofSchema` (discriminate on a `type` field — add `type:'webauthn_platform'` to the webauthn variant for symmetry, defaulting for back-compat). Extend the challenge endpoint to also issue a mobile nonce. **Step 4: PASS** + typecheck. **Step 5: Commit** — `feat: mobile proof schema + mobile nonce on approval challenge`.

---

## Task 6: assertApprovalAssurance — mobile_hw_key (L2) + PIN (L3)

**Files:** Modify `apps/api/src/services/authenticatorAssurance.ts` (+test), thread into `approvals.ts` + `pam.ts` (+tests).

- [ ] **Step 1: Failing tests** (node test keys, like Task 3):
  - mobile proof valid (consume nonce + `verifyMobileSignature` true, device found by `kind='mobile_hw_key'`+`credentialId is null` matching the proof's device) → `decidedVia='mobile_hw_key'`, level 2, device id, `signCount` bumped.
  - mobile proof + valid `pin` (`verifyPinAttempt` → verified) → level **3**, `pinVerified=true`.
  - mobile proof + WRONG pin → throws (never silently records L2 when L3 was attempted — a presented-but-bad PIN is an error). Locked PIN → throws a distinct lock error.
  - no proof → L1 (unchanged). webauthn proof → L2 (unchanged from P2).

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** — extend `assertApprovalAssurance` to branch on `proof.type`: webauthn (existing) vs mobile_hw_key (new: load device, `consumeMobileAssertionNonce`, `verifyMobileSignature`, bump signCount). After a valid factor, if `pin` was supplied, call `verifyPinAttempt`; verified → bump `decidedAssuranceLevel` to 3 + `pinVerified=true`; not verified → throw. **Invariants preserved:** no proof → L1; never block on absence. Decide paths map a thrown assertion/PIN error to 401 (as in P2). **Step 4: PASS** + typecheck. **Step 5: Commit** — `feat(api): mobile_hw_key + PIN assurance (L2/L3), non-blocking`.

---

## Task 7: Mobile HardwareSigner interface + adapter (native = manual)

**Files:** Create `apps/mobile/src/services/hardwareSigner.ts` + test; add `react-native-biometrics` to `apps/mobile/package.json`.

- [ ] **Step 1: Failing test** — define and test against the interface using a fake:

```ts
export interface HardwareSigner {
  isAvailable(): Promise<boolean>;
  createKeys(): Promise<{ publicKey: string }>;      // SPKI base64
  sign(payload: string, reason: string): Promise<{ signature: string }>; // RSA-SHA256 base64, biometric-gated
  deleteKeys(): Promise<boolean>;
}
```
Test a `fakeSigner` round-trips and that the consumer code (Task 8) uses the interface, not the concrete lib.

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** the interface + a `reactNativeBiometricsSigner` adapter that wraps `react-native-biometrics` `createKeys`/`createSignature`/`biometricKeysExist`/`deleteKeys`, plus a `nullSigner` (isAvailable→false) used when the native module is absent (Expo Go / tests). Export a `getHardwareSigner()` that returns the adapter when the native module loads, else `nullSigner`. **The adapter itself is the one file not unit-tested — flagged for on-device verification.** **Step 4: PASS** (interface + fake/null tests) + typecheck. **Step 5: Commit** — `feat(mobile): HardwareSigner interface + react-native-biometrics adapter`.

---

## Task 8: Mobile approval signing flow

**Files:** Modify `apps/mobile/src/screens/approvals/components/ApprovalButtons.tsx`; create `apps/mobile/src/services/approverDevice.ts` (+tests). Mock `HardwareSigner`.

- [ ] **Step 1: Failing tests** — on approve, the flow: POST `/mobile/approvals/:id/assertion-challenge` → if `mobileNonce` present and a signer is available, `signer.sign(nonce, 'Approve request')` → attach `{ proof: { type:'mobile_hw_key', credentialId, nonce, signature } }` to the approve body; if no registered device (`nullSigner`/no `mobileNonce`) → approve with no proof (L1) — **never block** (mirror the P2 web invariant). For high/critical riskTier, prompt the PIN entry and include `pin` in the body. Mock the signer + the API.

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** `approverDevice.ts` (register, getChallenge, sign-and-build-proof, pin set/verify API) and wire it into `ApprovalButtons.handleApprovePress` AFTER the existing `expo-local-authentication` biometric gate (the OS unlock) — the hardware `sign()` is the cryptographic proof on top. Keep the existing no-proof path as the device-less fallback. **Step 4: PASS** + typecheck. **Step 5: Commit** — `feat(mobile): hardware-key signed approvals + PIN`.

---

## Task 9: Mobile "Approver setup" screen (register device + set PIN)

**Files:** Create/modify under `apps/mobile/src/screens/settings/*` (+tests).

- [ ] **Step 1: Failing test** — a settings screen with "Register this device" (calls `signer.createKeys` → register via `/authenticator/devices/mobile-hw-key/{options,verify}` with the PoP signature) and "Set approval PIN" (`PUT /auth/pin`). Mock the signer + API; assert the register flow signs the PoP nonce and posts the public key, and the PIN flow validates 4-6 digits.

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** the screen mirroring existing mobile settings screens. **Step 4: PASS** + typecheck. **Step 5: Commit** — `feat(mobile): approver setup screen (register key + set PIN)`.

---

## Orchestrator-run gate (server, sandbox off where needed)

1. API unit: `pnpm --filter @breeze/api exec vitest run src/services/pin.test.ts src/services/mobileHwKey.test.ts src/routes/auth/pin.test.ts src/routes/authenticator.test.ts src/services/authenticatorAssurance.test.ts src/routes/approvals.test.ts src/routes/pam.test.ts`.
2. Shared: `pnpm --filter @breeze/shared exec vitest run src/validators/authenticator.test.ts`.
3. Mobile JS: the mobile test runner over the new specs.
4. Full `tsc --noEmit` (api + shared + mobile) — no new errors.
5. (No new RLS tables → P1 forge/coverage unaffected; no migration.)

## Manual handoff (CI-blind — on-device only)

- [ ] Add `react-native-biometrics` via an Expo config plugin; build a **dev client** (not Expo Go).
- [ ] On a physical iPhone + Android: register a device (Secure Enclave / StrongBox key, biometric-gated), confirm the PoP signature verifies server-side, then approve a real `approval_requests` push and confirm `decided_via='mobile_hw_key'` (and `pin_verified=true` for a high/critical with PIN).
- [ ] Confirm `createSignature` is genuinely biometric-gated (cancel → no signature) and the key is `WhenUnlockedThisDeviceOnly` / not exportable.

## Self-review

- **Spec coverage:** §6.2 PIN → T1/T2; §7.1 mobile register → T3/T4/T7/T9; §8.2-8.3 sign/verify → T3/T5/T6/T8; §9 guard L2/L3 → T6. **Deferred:** enforcement + org policy tab → P4; #1254 PAM→mobile bridge is separate.
- **Crypto contract proven without a device** via node RSA test vectors (T3/T6).
- **Non-blocking invariant:** no proof → L1; bad signature/PIN → throw (never silent downgrade); device-less mobile path approves at L1.
- **Type consistency:** `approvalProofSchema` discriminated union flows shared→mobile→route→`assertApprovalAssurance`; `decidedVia='mobile_hw_key'` matches the P1 enum; PIN is additive (any valid factor + PIN → L3).
- **No migration** (P1 columns/enum suffice).

## What Phase 3 deliberately does NOT do

No enforcement (device-less / PIN-less techs still approve at L1 — recorded). No org-policy admin UI. No PAM-elevation→mobile bridge (#1254). Those are Phase 4 / #1254.
