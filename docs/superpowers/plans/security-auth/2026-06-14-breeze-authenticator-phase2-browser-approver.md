# Breeze Authenticator — Phase 2 (Browser Approver) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a technician register a browser/Windows-Hello (WebAuthn **platform**) approver device, then satisfy an L2 biometric assertion at approval time — verified server-side and recorded — **without enforcement** (still non-blocking; enforcement is Phase 4).

**Architecture:** Reuse the shipped `@simplewebauthn` login stack (`services/passkeys.ts`, web `@simplewebauthn/browser`). Add approver-scoped registration (platform attachment) into the P1 `authenticator_devices` table, an approval-scoped assertion challenge (Redis, 120s, bound to `{approvalId,userId}`), and upgrade the P1 `resolveApprovalAssurance` seam into `assertApprovalAssurance` that verifies a presented assertion → records `decidedVia='webauthn_platform'`, level 2, device id (bumping `sign_count`). Web: a "Approval security" section in `ProfilePage` to register/manage approver devices, and a Windows-Hello step-up inserted into `PamRespondModal` + the approvals decide flow.

**Tech Stack:** TypeScript, Hono, Drizzle, `@simplewebauthn/server` + `/browser` (already deps), Astro+React, Vitest. Node v22.20.0.

**Spec:** `docs/superpowers/specs/security-auth/2026-06-14-breeze-authenticator-step-up-approvals-design.md` (§7.2 browser registration, §8 challenge/verify, §9 guard). Builds on Phase 1 (PR #1369).

**No DB migration** — P1 already added every column (`authenticator_devices`, `decided_via` enum already includes `webauthn_platform`, factor columns on both decide tables).

**Scope notes (deliberate):**
- **L2 only** (biometric assertion). PIN/L3 → Phase 3. **Org-policy admin tab + enforcement → Phase 4.** P2 ships the browser approver as an *opt-in stronger* approval that is *recorded* but never *required*.
- Every command runs in the worktree with pinned Node:
  `cd /Users/toddhebebrand/breeze-worktrees/authenticator-phase1` · `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`
- Known-noise: pre-existing `tsc` errors in `agents.test.ts`, `apiKeyAuth.test.ts`, `validators/ticketConfig.test.ts` — only NEW errors count.
- Web tests use jsdom (no DB/network). `recharts`/`ResizeObserver` not involved here. Mock `@simplewebauthn/browser` per the existing `auth.passkeys.test.ts` pattern.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/approverWebAuthn.ts` (create) | Approver registration options (platform attachment) + approval-scoped assertion challenge/verify, reusing `services/passkeys.ts` primitives |
| `apps/api/src/services/approverWebAuthn.test.ts` (create) | Unit tests (mock redis + @simplewebauthn) |
| `apps/api/src/routes/authenticator.ts` (create) | `POST /authenticator/devices/webauthn/{options,verify}`, `GET /me/approver-devices`, `POST /me/approver-devices/:id/revoke`, `PATCH /me/approver-devices/:id` |
| `apps/api/src/routes/authenticator.test.ts` (create) | Route tests (Drizzle mocks) |
| `apps/api/src/index.ts` (modify) | Mount `authenticatorRoutes` |
| `apps/api/src/services/authenticatorAssurance.ts` (modify) | Add `assertApprovalAssurance(...)` that verifies an optional assertion proof; keep `resolveApprovalAssurance` as the no-proof path |
| `apps/api/src/routes/approvals.ts` (modify) | `POST /:id/assertion-challenge`; thread optional `proof` through `decideHandler` |
| `apps/api/src/routes/pam.ts` (modify) | `POST /elevation-requests/:id/assertion-challenge`; add optional `proof` to `respondSchema` + thread it |
| `packages/shared/src/validators/authenticator.ts` (create) | Zod schema for the assertion `proof` body (shared API/web) |
| `apps/web/src/stores/authenticator.ts` (create) | Web client: register approver device, list/revoke, `getApprovalAssertion(path,id)` (mirrors `apiVerifyPasskeyMFA`) |
| `apps/web/src/components/settings/ApproverDevicesSection.tsx` (create) | ProfilePage section: register + list + revoke approver devices |
| `apps/web/src/components/settings/ProfilePage.tsx` (modify) | Mount the new section |
| `apps/web/src/components/pam/PamRespondModal.tsx` (modify) | Insert Windows-Hello step-up before `runAction` on approve |
| `apps/web/src/components/approvals/*` (modify) | Same step-up on the unified approvals approve flow (locate the approve handler) |

---

## Task 1: Shared validator for the assertion proof

**Files:**
- Create: `packages/shared/src/validators/authenticator.ts`
- Test: `packages/shared/src/validators/authenticator.test.ts`
- Modify: `packages/shared/src/validators/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/validators/authenticator.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { assertionProofSchema } from './authenticator';

describe('assertionProofSchema', () => {
  it('accepts a well-formed WebAuthn assertion proof', () => {
    const r = assertionProofSchema.safeParse({
      credentialId: 'abc',
      authenticatorData: 'AA',
      clientDataJSON: 'BB',
      signature: 'CC',
      userHandle: null,
    });
    expect(r.success).toBe(true);
  });
  it('rejects when required fields are missing', () => {
    expect(assertionProofSchema.safeParse({ credentialId: 'x' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`pnpm --filter @breeze/shared exec vitest run src/validators/authenticator.test.ts`).

- [ ] **Step 3: Implement** `packages/shared/src/validators/authenticator.ts`:

```ts
import { z } from 'zod';

/**
 * The browser's WebAuthn assertion response (from @simplewebauthn/browser
 * startAuthentication) that a technician presents when approving. Shapes match
 * @simplewebauthn/server's AuthenticationResponseJSON. base64url strings.
 */
export const assertionProofSchema = z.object({
  credentialId: z.string().min(1),
  authenticatorData: z.string().min(1),
  clientDataJSON: z.string().min(1),
  signature: z.string().min(1),
  userHandle: z.string().nullable().optional(),
});

export type AssertionProof = z.infer<typeof assertionProofSchema>;
```

Add `export * from './authenticator';` to `packages/shared/src/validators/index.ts`.

- [ ] **Step 4: Run tests — expect PASS.** Typecheck shared.

- [ ] **Step 5: Commit** — `feat(shared): assertion proof validator`.

---

## Task 2: Approver WebAuthn service

**Files:**
- Create: `apps/api/src/services/approverWebAuthn.ts`
- Test: `apps/api/src/services/approverWebAuthn.test.ts`

Reuse from `services/passkeys.ts` (recon-confirmed exports/signatures): `resolveWebAuthnConfig()`, `registrationInfoToPasskeyFields(verification,response)`, `authenticationInfoToPasskeyUpdateFields(verification)`, `passkeyToWebAuthnCredential(stored)`, `encodeBase64Url/decodeBase64Url`. From `@simplewebauthn/server`: `generateRegistrationOptions`, `verifyRegistrationResponse`, `generateAuthenticationOptions`, `verifyAuthenticationResponse`.

- [ ] **Step 1: Write the failing test** `apps/api/src/services/approverWebAuthn.test.ts` — mock `redis` + `@simplewebauthn/server`. Assert:
  - `generateApproverRegistrationOptions({user, existing})` returns options with `authenticatorSelection.authenticatorAttachment === 'platform'`, `userVerification === 'required'`, and stores a registration challenge in Redis at `approver-reg:<userId>`.
  - `generateApprovalAssertionOptions({approvalId, userId, devices})` stores a challenge at `approval-assertion:<approvalId>:<userId>` with a 120s TTL and returns `allowCredentials` from the devices.
  - `verifyApprovalAssertion({approvalId, userId, response, device})` consumes the challenge (getdel), calls `verifyAuthenticationResponse`, and returns `{verified, newSignCount}`; a second call (challenge gone) rejects.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
// vi.mock('@simplewebauthn/server', ...) and the redis client per the existing
// passkeys.test.ts mock setup — copy that file's mock scaffold verbatim.
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `apps/api/src/services/approverWebAuthn.ts`:

```ts
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import { redis } from '../redis'; // use the project's redis client import (match passkeys.ts)
import {
  resolveWebAuthnConfig,
  registrationInfoToPasskeyFields,
  passkeyToWebAuthnCredential,
  type StoredPasskeyCredential,
  type PasskeyRegistrationStoreFields,
} from './passkeys';

const ASSERTION_TTL_SECONDS = 120; // spec §6.5 — short decision window
const REG_TTL_SECONDS = 300;

const regKey = (userId: string) => `approver-reg:${userId}`;
const assertionKey = (approvalId: string, userId: string) => `approval-assertion:${approvalId}:${userId}`;

export async function generateApproverRegistrationOptions(input: {
  user: { id: string; name: string; displayName: string };
  existing?: { credentialId: string; transports?: string[] | null }[];
}) {
  const cfg = resolveWebAuthnConfig();
  const options = await generateRegistrationOptions({
    rpName: cfg.rpName,
    rpID: cfg.rpID,
    userName: input.user.name,
    userDisplayName: input.user.displayName,
    attestationType: 'none',
    excludeCredentials: (input.existing ?? []).map((c) => ({ id: c.credentialId, transports: c.transports as any })),
    authenticatorSelection: {
      authenticatorAttachment: 'platform', // §7.2 — Windows Hello / Touch ID, device-bound
      residentKey: 'preferred',
      userVerification: 'required',
    },
  });
  await redis.set(regKey(input.user.id), options.challenge, 'EX', REG_TTL_SECONDS);
  return options;
}

export async function verifyApproverRegistration(input: {
  userId: string;
  response: Parameters<typeof verifyRegistrationResponse>[0]['response'];
}): Promise<PasskeyRegistrationStoreFields & { isPlatformBound: boolean }> {
  const cfg = resolveWebAuthnConfig();
  const expectedChallenge = await redis.getdel(regKey(input.userId));
  if (!expectedChallenge) throw new Error('approver registration challenge expired');
  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge,
    expectedOrigin: cfg.origin,
    expectedRPID: cfg.rpID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) throw new Error('approver registration not verified');
  const fields = registrationInfoToPasskeyFields(verification, input.response);
  // §6.1 / §12 — only a non-syncable, single-device platform credential is L4-eligible.
  const isPlatformBound = fields.deviceType === 'singleDevice' && !fields.backedUp;
  return { ...fields, isPlatformBound };
}

export async function generateApprovalAssertionOptions(input: {
  approvalId: string;
  userId: string;
  devices: { credentialId: string; transports?: string[] | null }[];
}) {
  const cfg = resolveWebAuthnConfig();
  const options = await generateAuthenticationOptions({
    rpID: cfg.rpID,
    userVerification: 'required',
    allowCredentials: input.devices.map((d) => ({ id: d.credentialId, transports: d.transports as any })),
  });
  await redis.set(assertionKey(input.approvalId, input.userId), options.challenge, 'EX', ASSERTION_TTL_SECONDS);
  return options;
}

export async function verifyApprovalAssertion(input: {
  approvalId: string;
  userId: string;
  response: Parameters<typeof verifyAuthenticationResponse>[0]['response'];
  device: StoredPasskeyCredential; // {credentialId, publicKey, counter(signCount), transports}
}): Promise<{ verified: boolean; newSignCount: number }> {
  const cfg = resolveWebAuthnConfig();
  const expectedChallenge = await redis.getdel(assertionKey(input.approvalId, input.userId));
  if (!expectedChallenge) throw new Error('approval assertion challenge expired or already used');
  const verification: VerifiedAuthenticationResponse = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge,
    expectedOrigin: cfg.origin,
    expectedRPID: cfg.rpID,
    credential: passkeyToWebAuthnCredential(input.device),
    requireUserVerification: true,
  });
  // @simplewebauthn enforces the signCount anti-clone check internally (rejects newCounter <= oldCounter).
  return { verified: verification.verified, newSignCount: verification.authenticationInfo.newCounter };
}
```

> If the redis import path / `getdel` wrapper differs, match exactly what `services/passkeys.ts` uses (the recon shows it uses a `getdel`-style atomic consume). Reuse its private challenge helper signatures if they are exported; otherwise the above standalone keys are correct (spec §6.5).

- [ ] **Step 4: Run tests — expect PASS.** Typecheck `@breeze/api`.

- [ ] **Step 5: Commit** — `feat(api): approver WebAuthn service (platform registration + approval assertion)`.

---

## Task 3: Approver device routes

**Files:**
- Create: `apps/api/src/routes/authenticator.ts`
- Test: `apps/api/src/routes/authenticator.test.ts`
- Modify: `apps/api/src/index.ts`

Endpoints (all under the authenticated user; password step-up on registration mirroring `routes/auth/passkeys.ts` via `requireCurrentPasswordStepUp`):
- `POST /authenticator/devices/webauthn/options` → `generateApproverRegistrationOptions`.
- `POST /authenticator/devices/webauthn/verify` → `verifyApproverRegistration` → insert `authenticator_devices` row (`kind:'webauthn_platform'`, `publicKey`, `credentialId`, `signCount`, `aaguid`, `transports`, `isPlatformBound`, `label`); audit `auth.authenticator.device.register`.
- `GET /me/approver-devices` → list the caller's `authenticator_devices` where `disabledAt IS NULL` (RLS already scopes to the user; add `.where(eq(userId, auth.user.id))` defense-in-depth — see reference memory).
- `POST /me/approver-devices/:id/revoke` → set `disabledAt=now()`, `disabledReason`; audit.
- `PATCH /me/approver-devices/:id` → rename `label`.

- [ ] **Step 1: Write failing route tests** (Drizzle-mock pattern from `routes/auth/passkeys.test.ts` — copy its scaffold). Assert: options route returns options + 200; verify route inserts a row with `kind='webauthn_platform'` and the computed `isPlatformBound`; list returns only the caller's active devices; revoke sets `disabledAt`.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `routes/authenticator.ts` (Hono router `authenticatorRoutes`, mounted in `index.ts` under the authed group). Mirror `routes/auth/passkeys.ts` for the step-up + options/verify shape; insert into `authenticatorDevices` instead of `userPasskeys`. Wrap mutations so failures surface (server-side). Mount in `index.ts`: `app.route('/authenticator', authenticatorRoutes)` and the `/me/approver-devices` group where the other `/me` routes live (match existing mount conventions).

- [ ] **Step 4: Run tests — expect PASS.** Typecheck.

- [ ] **Step 5: Commit** — `feat(api): approver device registration + management routes`.

---

## Task 4: `assertApprovalAssurance` — verify a presented proof (non-blocking)

**Files:**
- Modify: `apps/api/src/services/authenticatorAssurance.ts`
- Test: `apps/api/src/services/authenticatorAssurance.test.ts` (extend)

Add an async `assertApprovalAssurance` that, GIVEN an optional proof + a DB handle, verifies the assertion against the caller's `authenticator_devices` row and returns the achieved `AssuranceDecision`. **Non-blocking:** if no proof → return the P1 `resolveApprovalAssurance` result (session_tap/L1); if proof present and valid → `webauthn_platform`/L2 + device id; if proof present but INVALID → throw (a presented-but-bad proof is an error, not a silent downgrade). Enforcement of "proof REQUIRED" stays Phase 4.

- [ ] **Step 1: Write failing tests** — extend `authenticatorAssurance.test.ts`:
  - no proof → `decidedVia='session_tap'`, level 1 (unchanged).
  - valid proof (mock `verifyApprovalAssertion` → `{verified:true,newSignCount:5}`, device found) → `decidedVia='webauthn_platform'`, level 2, `authenticatorDeviceId=<id>`, and `signCount` bumped.
  - proof present but device not found / `verified:false` → throws.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — add to `authenticatorAssurance.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { authenticatorDevices } from '../db/schema';
import { verifyApprovalAssertion } from './approverWebAuthn';
import type { AssertionProof } from '@breeze/shared';
import type { RiskTier } from '@breeze/shared';

export async function assertApprovalAssurance(input: {
  approvalId: string;
  userId: string;
  riskTier: RiskTier;
  proof?: AssertionProof | null;
}): Promise<AssuranceDecision> {
  // No proof presented → today's behavior (session tap, L1). NEVER blocks in P2.
  if (!input.proof) return resolveApprovalAssurance(input.riskTier);

  const [device] = await db
    .select()
    .from(authenticatorDevices)
    .where(and(
      eq(authenticatorDevices.userId, input.userId),
      eq(authenticatorDevices.credentialId, input.proof.credentialId),
      eq(authenticatorDevices.kind, 'webauthn_platform'),
      isNull(authenticatorDevices.disabledAt),
    ))
    .limit(1);
  if (!device) throw new Error('authenticator device not registered or disabled');

  const { verified, newSignCount } = await verifyApprovalAssertion({
    approvalId: input.approvalId,
    userId: input.userId,
    response: {
      id: input.proof.credentialId,
      rawId: input.proof.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        authenticatorData: input.proof.authenticatorData,
        clientDataJSON: input.proof.clientDataJSON,
        signature: input.proof.signature,
        userHandle: input.proof.userHandle ?? undefined,
      },
    },
    device: {
      credentialId: device.credentialId!,
      publicKey: device.publicKey,
      counter: device.signCount,
      transports: device.transports as any,
    },
  });
  if (!verified) throw new Error('assertion verification failed');

  await db.update(authenticatorDevices)
    .set({ signCount: newSignCount, lastUsedAt: new Date() })
    .where(eq(authenticatorDevices.id, device.id));

  return {
    requiredLevel: resolveApprovalAssurance(input.riskTier).requiredLevel,
    decidedAssuranceLevel: 2,
    decidedVia: 'webauthn_platform',
    authenticatorDeviceId: device.id,
    pinVerified: false, // PIN is Phase 3
  };
}
```

- [ ] **Step 4: Run — expect PASS.** Typecheck.

- [ ] **Step 5: Commit** — `feat(api): assertApprovalAssurance verifies browser assertion (non-blocking)`.

---

## Task 5: Assertion challenge + proof on the approvals decide path

**Files:**
- Modify: `apps/api/src/routes/approvals.ts`
- Test: `apps/api/src/routes/approvals.test.ts` (extend)

- [ ] **Step 1: Write failing tests:** `POST /:id/assertion-challenge` returns options for the caller's active approver devices; `POST /:id/approve` with a valid `proof` records `decidedVia='webauthn_platform'`/level 2 (mock `assertApprovalAssurance`); `approve` with no proof still records `session_tap`/1 (unchanged).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement:**
  (a) Add `approvalRoutes.post('/:id/assertion-challenge', ...)`: load the pending approval (scoped to `userId`), load the caller's active `webauthn_platform` devices, call `generateApprovalAssertionOptions({approvalId:id, userId, devices})`, return the options.
  (b) Accept an optional `proof` in the approve body (validate with `assertionProofSchema`). In `decideHandler`, replace the `resolveApprovalAssurance(existing.riskTier)` call with `await assertApprovalAssurance({ approvalId: id, userId, riskTier: existing.riskTier as RiskTier, proof })`. Everything else (CAS update writing the factor columns) is unchanged. A thrown verification error → `401 {error:'assertion_failed'}` (NOT a silent downgrade).

- [ ] **Step 4: Run — expect PASS.** Typecheck.

- [ ] **Step 5: Commit** — `feat(api): assertion-challenge + proof on approvals decide`.

---

## Task 6: Assertion challenge + proof on the PAM respond path

**Files:**
- Modify: `apps/api/src/routes/pam.ts`
- Test: `apps/api/src/routes/pam.test.ts` (extend)

- [ ] **Step 1: Write failing tests** mirroring Task 5 for `/pam/elevation-requests/:id/respond` (proof → `webauthn_platform`/2; no proof → `session_tap`/1).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement:**
  (a) Add `pamRoutes.post('/elevation-requests/:id/assertion-challenge', requirePamExecute, ...)` mirroring Task 5a (load elevation scoped by `canAccessOrg`, caller's devices, generate options).
  (b) Add `proof: assertionProofSchema.optional()` to `respondSchema`. In the respond transaction, replace `resolveElevationAssurance(row.riskTier)` with `await assertApprovalAssurance({ approvalId: id, userId: auth.user.id, riskTier: elevationRiskTierToName(row.riskTier), proof: body.proof })`. (Import `elevationRiskTierToName` from `@breeze/shared`.) Thrown error → 401. The `elevationAudit.details` already carries `assurance_level`/`factor` — they now reflect the achieved L2/`webauthn_platform`.

- [ ] **Step 4: Run — expect PASS.** Typecheck.

- [ ] **Step 5: Commit** — `feat(api): assertion-challenge + proof on PAM respond`.

---

## Task 7: Web client — approver registration + assertion helpers

**Files:**
- Create: `apps/web/src/stores/authenticator.ts`
- Test: `apps/web/src/stores/authenticator.test.ts`

Mirror the proven `apiVerifyPasskeyMFA` 3-step pattern in `stores/auth.ts` (recon): use `@simplewebauthn/browser` `startRegistration` / `startAuthentication` (already a dep). Reuse the app's `fetchWithAuth`.

- [ ] **Step 1: Write failing tests** — mock `@simplewebauthn/browser` exactly as `stores/auth.passkeys.test.ts` does. Assert `registerApproverDevice()` does options→startRegistration→verify, and `getApprovalAssertion(basePath,id)` does challenge→startAuthentication→returns the proof body.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `stores/authenticator.ts`:

```ts
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { fetchWithAuth } from '../lib/...'; // match the project's helper import

export async function registerApproverDevice(label: string): Promise<void> {
  const options = await fetchWithAuth('/authenticator/devices/webauthn/options', { method: 'POST' }).then((r) => r.json());
  const attResp = await startRegistration(options);
  await fetchWithAuth('/authenticator/devices/webauthn/verify', {
    method: 'POST', body: JSON.stringify({ label, response: attResp }),
  });
}

export async function listApproverDevices() {
  return fetchWithAuth('/me/approver-devices').then((r) => r.json());
}
export async function revokeApproverDevice(id: string) {
  return fetchWithAuth(`/me/approver-devices/${id}/revoke`, { method: 'POST' });
}

/** challenge -> Windows Hello -> proof body for an approve call. basePath is the
 *  decide resource, e.g. `/approvals` or `/pam/elevation-requests`. */
export async function getApprovalAssertion(basePath: string, id: string) {
  const options = await fetchWithAuth(`${basePath}/${id}/assertion-challenge`, { method: 'POST' }).then((r) => r.json());
  const asseResp = await startAuthentication(options);
  return {
    credentialId: asseResp.id,
    authenticatorData: asseResp.response.authenticatorData,
    clientDataJSON: asseResp.response.clientDataJSON,
    signature: asseResp.response.signature,
    userHandle: asseResp.response.userHandle ?? null,
  };
}
```

- [ ] **Step 4: Run — expect PASS.** Typecheck web.

- [ ] **Step 5: Commit** — `feat(web): approver device + assertion client helpers`.

---

## Task 8: ProfilePage "Approval security" section

**Files:**
- Create: `apps/web/src/components/settings/ApproverDevicesSection.tsx`
- Modify: `apps/web/src/components/settings/ProfilePage.tsx`
- Test: `apps/web/src/components/settings/ApproverDevicesSection.test.tsx`

Mirror the passkey list + `MobileDevicesPage` revoke pattern (recon). The section: a "Register this device" button (`registerApproverDevice`, wrapped in `runAction`), a list of devices (label, platform-bound badge, createdAt, lastUsedAt), and a revoke button with a confirm dialog.

- [ ] **Step 1: Write a failing test** — render the section, mock `stores/authenticator`, assert the register button calls `registerApproverDevice` and the list renders devices by `data-testid`.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** the component mirroring `ProfilePage` passkey UI + `MobileDevicesPage` (copy structure; swap the data source to `stores/authenticator`). Mount it in `ProfilePage.tsx` as a new section/tab. Use `data-testid` on rows/buttons. Wrap mutations in `runAction` (CLAUDE.md `no-silent-mutations`).

- [ ] **Step 4: Run — expect PASS.** Typecheck web.

- [ ] **Step 5: Commit** — `feat(web): approval-security section to register/manage approver devices`.

---

## Task 9: Console approve-with-Hello step-up (PAM)

**Files:**
- Modify: `apps/web/src/components/pam/PamRespondModal.tsx`
- Test: `apps/web/src/components/pam/PamRespondModal.test.tsx` (create/extend)

Insertion point (recon): `handleSubmit` (~lines 27-69), between decision-validation and the `runAction` call, on the **approve** path only.

- [ ] **Step 1: Write a failing test** — mock `stores/authenticator.getApprovalAssertion` to return a proof; assert that on approve, the POST body to `/pam/elevation-requests/:id/respond` includes `proof`; on deny, no assertion is requested. Mock a WebAuthn cancellation (startAuthentication throws) → surfaces an error, does not submit.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — in `handleSubmit`, if `decision==='approve'`, attempt `const proof = await getApprovalAssertion('/pam/elevation-requests', request.id)` inside try/catch (a thrown cancellation sets local error + aborts), then include `proof` in the `runAction` request body. Deny path unchanged. **Graceful fallback:** if the user has no registered approver device, the challenge endpoint returns empty `allowCredentials`; catch that and submit without proof (records L1) — P2 is opt-in, not required.

- [ ] **Step 4: Run — expect PASS.** Typecheck web.

- [ ] **Step 5: Commit** — `feat(web): Windows Hello step-up on PAM approve`.

---

## Task 10: Console approve-with-Hello step-up (unified approvals)

**Files:**
- Modify: the approvals approve handler (locate via `grep -rn "/approvals/" apps/web/src` — likely a `MobileApprovalsPage`/`ApprovalsList` or the AI-approval card). 
- Test: alongside.

- [ ] **Step 1: Write a failing test** mirroring Task 9 for the approvals decide call (`/approvals/:id/approve` body includes `proof`).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** the same `getApprovalAssertion('/approvals', id)` step before the approve `runAction`, same graceful fallback. (If the only approvals approve UI is the mobile app — out of P2 scope — note that and limit P2 to the web/PAM console surfaces; record the gap.)

- [ ] **Step 4: Run — expect PASS.** Typecheck web.

- [ ] **Step 5: Commit** — `feat(web): Windows Hello step-up on approvals approve`.

---

## Live-DB / integration gate (orchestrator-run, sandbox off)

After the workflow commits all tasks, the orchestrator runs (agents can't reach the DB):
1. `pnpm --filter @breeze/api exec vitest run src/services/approverWebAuthn.test.ts src/routes/authenticator.test.ts src/services/authenticatorAssurance.test.ts src/routes/approvals.test.ts src/routes/pam.test.ts` (unit).
2. `pnpm --filter @breeze/web exec vitest run` for the new web tests.
3. Full `tsc --noEmit` (api + web + shared) — no new errors.
4. A focused integration test (new, optional): register an approver device + a full assertion round-trip against the test DB, asserting `decided_via='webauthn_platform'` is persisted. (Real WebAuthn assertions can't be forged in a test without a virtual authenticator; assert the wiring with `verifyApprovalAssertion` mocked at the boundary, OR use `@simplewebauthn`'s test vectors.)

---

## Self-review

- **Spec coverage:** §7.2 browser registration → T2/T3; §8 challenge/verify → T2/T4/T5/T6; §9 guard (assert) → T4; web register/manage → T7/T8; console step-up → T9/T10. **Deferred (correct):** PIN/L3 (P3), org-policy tab + enforcement (P4), mobile authenticator (P3).
- **Non-blocking invariant:** T4 returns the P1 result when no proof; only a *presented-but-invalid* proof throws — never a silent downgrade, never a block on absence.
- **Type consistency:** `AssertionProof` (T1) flows T7→route→T4→`verifyApprovalAssertion` (T2); `decidedVia='webauthn_platform'` matches the P1 enum; `AssuranceDecision` shape unchanged.
- **No migration** — P1 columns/enum suffice.
- **Reuse:** verified against recon — `verifyAuthenticationResponse` does the signCount anti-clone check internally; `@simplewebauthn/browser` is already a web dep.

## What Phase 2 deliberately does NOT do

No enforcement (a tech without a registered device, or who skips Hello, still approves at L1 — recorded as such). No PIN/L3. No org-policy admin UI. No mobile authenticator. Those are Phases 3–4.
