# Authenticator Registration & Assurance Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the phone an approver simply by being logged in (no separate setup), surface registered phones on the web, and replace the static PIN with an L4-only fresh re-auth — revising the unmerged #1369 in place.

**Architecture:** The mobile app mints its Secure-Enclave key silently at login and POSTs the public key with no password step-up; the key activates on its first approval signature (deferred proof-of-possession). The `assertApprovalAssurance` server guard keeps the risk→L1–L4 ladder but swaps the PIN for a recency window (L3) and a fresh account re-auth (L4). The web "Approval security" panel lists all of a user's approver devices.

**Tech Stack:** Hono + Drizzle (API), Vitest (API unit + mobile pure-logic), React Native + react-native-biometrics (mobile), Astro + React (web). Branch: `feat/breeze-authenticator-step-up` (#1369). Node pinned: prefix `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.

**Spec:** `docs/superpowers/specs/security-auth/2026-06-15-authenticator-registration-redesign-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/api/src/services/authenticatorAssurance.ts` | server step-up guard | L3 recency + L4 re-auth; remove PIN branches |
| `apps/api/src/routes/authenticator.ts` | device registration endpoints | drop password step-up; activate on first signature |
| `apps/api/src/routes/auth/pin.ts` + `.test.ts` | PIN endpoint | **delete** |
| `apps/api/src/services/pin.ts` + `.test.ts` | PIN hashing/verify | **delete** |
| `packages/shared/src/validators/authenticator.ts` | proof/registration schemas | drop PIN + currentPassword fields |
| `apps/api/src/db/schema/users.ts` | approver-PIN columns | drop in migration |
| `apps/api/migrations/2026-06-15-drop-approver-pin.sql` | column teardown | **create** |
| `apps/mobile/src/services/approverDevice.ts` | mobile approver client | add `ensureApproverDevice()`; drop password/PIN |
| `apps/mobile/src/navigation/RootNavigator.tsx` | post-auth side-effects | call `ensureApproverDevice()` after auth |
| `apps/mobile/src/screens/approvals/components/ApproverSetupSheet.tsx` | setup sheet | **delete** |
| `apps/mobile/src/screens/chat/components/SettingsSheet.tsx` | settings | remove the wiring added this session |
| `apps/web/src/components/settings/ApproverDevicesSection.tsx` | web approver UI | list all devices incl. phones |

---

## Task 1: Drop the PIN — shared validators

**Files:**
- Modify: `packages/shared/src/validators/authenticator.ts`
- Test: `packages/shared/src/validators/authenticator.test.ts`

- [ ] **Step 1: Read the current schemas.** Read `packages/shared/src/validators/authenticator.ts`. Identify the registration-options schema (currently carries `currentPassword`) and any `setPinSchema` / `pin` field on the proof schema.

- [ ] **Step 2: Write the failing test** in `authenticator.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mobileHwKeyRegisterSchema } from './authenticator';

describe('mobileHwKeyRegisterSchema (no password step-up)', () => {
  it('accepts a registration body with no currentPassword', () => {
    const parsed = mobileHwKeyRegisterSchema.safeParse({ publicKey: 'pk', label: 'My iPhone' });
    expect(parsed.success).toBe(true);
  });
  it('rejects an unknown pin field', () => {
    const parsed = mobileHwKeyRegisterSchema.safeParse({ publicKey: 'pk', label: 'x', pin: '1234' });
    // strict schema strips or rejects — assert pin never survives
    if (parsed.success) expect('pin' in parsed.data).toBe(false);
  });
});
```

- [ ] **Step 3: Run, verify it fails.** `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run packages/shared/src/validators/authenticator.test.ts -t "no password step-up"` → FAIL (schema not exported / still requires currentPassword).

- [ ] **Step 4: Edit the schema.** In `authenticator.ts`: remove `currentPassword` from the registration schema, delete `setPinSchema`, and remove any `pin` field from the proof schema. Export `mobileHwKeyRegisterSchema` as `{ publicKey: z.string().min(1), label: z.string().min(1).max(255) }` (use `.strict()`).

- [ ] **Step 5: Run, verify pass.** Same command → PASS.

- [ ] **Step 6: Commit.** `git add packages/shared/src/validators/authenticator.* && git commit -m "refactor(authenticator): drop PIN + password step-up from validators"`

---

## Task 2: Delete the PIN server feature

**Files:**
- Delete: `apps/api/src/routes/auth/pin.ts`, `apps/api/src/routes/auth/pin.test.ts`, `apps/api/src/services/pin.ts`, `apps/api/src/services/pin.test.ts`
- Modify: `apps/api/src/index.ts` (unmount the pin route), `apps/api/src/routes/approvals.ts`, `apps/api/src/routes/pam.ts` (remove `pin_verified` writes)

- [ ] **Step 1: Find every reference.** Run `grep -rnE "pin\.ts|pinRoutes|verifyPin|setPin|pin_verified|pinVerified|setApproverPin" apps/api/src`. Note each call site.

- [ ] **Step 2: Delete the files.** `git rm apps/api/src/routes/auth/pin.ts apps/api/src/routes/auth/pin.test.ts apps/api/src/services/pin.ts apps/api/src/services/pin.test.ts`

- [ ] **Step 3: Unmount + de-reference.** Remove the pin route mount from `index.ts` and delete `pin_verified` assignments in `approvals.ts` / `pam.ts` decide handlers (leave the column write out entirely; the column itself is dropped in Task 7).

- [ ] **Step 4: Typecheck.** `PATH=…:$PATH npx tsc --noEmit -p apps/api/tsconfig.json` → no references to deleted symbols. Fix any stragglers.

- [ ] **Step 5: Commit.** `git add -A apps/api && git commit -m "refactor(authenticator): remove PIN routes/service and pin_verified writes"`

---

## Task 3: Assurance ladder — L3 recency, L4 re-auth, no PIN

**Files:**
- Modify: `apps/api/src/services/authenticatorAssurance.ts`
- Test: `apps/api/src/services/authenticatorAssurance.test.ts`

- [ ] **Step 1: Read `authenticatorAssurance.ts` fully.** Locate where it currently branches on PIN for L3 and platform-bound for L4, and the Redis challenge TTL constant.

- [ ] **Step 2: Write failing tests** capturing the new factors:

```ts
// L3: a valid signature whose challenge is within TTL satisfies high; expired fails.
it('L3 (high) accepts a fresh signature and rejects an expired challenge', async () => {
  const fresh = await assertApprovalAssurance(highApprovalCtx({ challengeAgeMs: 10_000 }));
  expect(fresh.level).toBe(3);
  await expect(assertApprovalAssurance(highApprovalCtx({ challengeAgeMs: 130_000 })))
    .rejects.toThrow(/expired|recency/i);
});

// L4: critical needs hardware-bound key AND a fresh re-auth assertion.
it('L4 (critical) requires hardware-bound key + fresh re-auth', async () => {
  await expect(assertApprovalAssurance(criticalCtx({ reauth: false })))
    .rejects.toThrow(/re-?auth/i);
  const ok = await assertApprovalAssurance(criticalCtx({ reauth: true, isPlatformBound: true }));
  expect(ok.level).toBe(4);
});

// PIN is gone: no pin in context, high still satisfiable by signature+recency alone.
it('does not require a PIN for high', async () => {
  const r = await assertApprovalAssurance(highApprovalCtx({ challengeAgeMs: 5_000 }));
  expect(r.level).toBe(3);
});
```

(Adapt `highApprovalCtx`/`criticalCtx` to the existing test's fixture helpers — read the test file first and reuse its builders.)

- [ ] **Step 3: Run, verify fail.** `PATH=…:$PATH npx vitest run apps/api/src/services/authenticatorAssurance.test.ts` → FAIL on the new cases.

- [ ] **Step 4: Implement.** In `authenticatorAssurance.ts`:
  - **L3:** require a verified L2 signature whose Redis challenge was issued within the TTL. Make the TTL an exported constant `APPROVAL_CHALLENGE_TTL_MS = 120_000`; reject when `Date.now() - issuedAt > APPROVAL_CHALLENGE_TTL_MS`.
  - **L4:** require L3 conditions + `device.is_platform_bound === true` + a fresh re-auth flag on the context (`ctx.reauthVerified === true`). Throw `StepUpRequiredError`/`ReauthRequiredError` when absent (mirror the existing error type).
  - Delete all PIN verification branches.

- [ ] **Step 5: Run, verify pass.** Same command → PASS.

- [ ] **Step 6: Commit.** `git add apps/api/src/services/authenticatorAssurance.* && git commit -m "feat(authenticator): L3 recency + L4 re-auth, drop PIN factor"`

---

## Task 4: Registration without password; activate on first signature

**Files:**
- Modify: `apps/api/src/routes/authenticator.ts`
- Test: `apps/api/src/routes/authenticator.test.ts`

- [ ] **Step 1: Read `authenticator.ts`.** Find the `mobile-hw-key/options` (issues PoP nonce, checks password) and `mobile-hw-key/verify` handlers.

- [ ] **Step 2: Write failing tests:**

```ts
it('registers a mobile_hw_key with no password and stores it pending', async () => {
  const res = await postAuthed('/api/v1/authenticator/devices', { kind: 'mobile_hw_key', publicKey: 'pk', label: 'iPhone', isPlatformBound: true });
  expect(res.status).toBe(201);
  const row = await getDevice(res.body.device.id);
  expect(row.disabled_at).toBeNull();
  expect(row.label).toBe('iPhone');
  // pending until first signature — assert your chosen "pending" marker (e.g. last_used_at null + a status, per schema)
});
```

- [ ] **Step 3: Run, verify fail.** `PATH=…:$PATH npx vitest run apps/api/src/routes/authenticator.test.ts -t "no password"` → FAIL.

- [ ] **Step 4: Implement.** Collapse the two-step options/verify into a single `POST /api/v1/authenticator/devices` that (a) requires only auth (no `currentPassword`), (b) validates with `mobileHwKeyRegisterSchema`, (c) inserts the row as pending. Remove the password check. In `authenticatorAssurance.ts`'s signature-verify path (Task 3 area), on a successful signature against a pending device, flip it active (`last_used_at = now()`, clear pending marker).

- [ ] **Step 5: Run, verify pass.** Same command → PASS. Also re-run Task 3 tests to confirm activation-on-first-signature didn't regress.

- [ ] **Step 6: Commit.** `git add apps/api/src/routes/authenticator.* && git commit -m "feat(authenticator): passwordless registration, activate on first signature"`

---

## Task 5: Mobile — ensureApproverDevice + login hook; delete setup sheet

**Files:**
- Modify: `apps/mobile/src/services/approverDevice.ts`
- Test: `apps/mobile/src/services/approverDevice.test.ts`
- Modify: `apps/mobile/src/navigation/RootNavigator.tsx`
- Delete: `apps/mobile/src/screens/approvals/components/ApproverSetupSheet.tsx`
- Modify: `apps/mobile/src/screens/chat/components/SettingsSheet.tsx`

- [ ] **Step 1: Write the failing test** for the new idempotent provisioner (`approverDevice.test.ts`), reusing the existing fake `HardwareSigner`:

```ts
describe('ensureApproverDevice', () => {
  it('mints + registers a key when none exists, stores the credential id', async () => {
    const signer = fakeSigner({ available: true, publicKey: 'pk' });
    server.post('/api/v1/authenticator/devices').reply({ device: { id: 'dev-1' } });
    await ensureApproverDevice(signer);
    expect(await SecureStore.getItemAsync('breeze_approver_credential_id')).toBe('dev-1');
    expect(signer.createKeys).toHaveBeenCalledTimes(1);
  });
  it('is a no-op when a credential id already exists', async () => {
    await SecureStore.setItemAsync('breeze_approver_credential_id', 'dev-1');
    const signer = fakeSigner({ available: true });
    await ensureApproverDevice(signer);
    expect(signer.createKeys).not.toHaveBeenCalled();
  });
  it('no-ops silently when no biometric hardware (no throw on the login path)', async () => {
    const signer = fakeSigner({ available: false });
    await expect(ensureApproverDevice(signer)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify fail.** `PATH=…:$PATH npx vitest run apps/mobile/src/services/approverDevice.test.ts -t ensureApproverDevice` → FAIL.

- [ ] **Step 3: Implement `ensureApproverDevice`.** Add to `approverDevice.ts`:

```ts
/**
 * Idempotent: ensure this phone has a registered approver key. Called after
 * auth lands (fresh login or restored session). FAILS OPEN — any error
 * (no hardware, offline) leaves the device unregistered; it provisions on a
 * later call. The biometric prompt is NOT triggered here (createKeys is
 * silent); the first approval signature is the first prompt and also activates
 * the device server-side.
 */
export async function ensureApproverDevice(
  signer: HardwareSigner = getHardwareSigner(),
): Promise<void> {
  try {
    if (await SecureStore.getItemAsync(CRED_ID_KEY)) return;       // already registered
    if (!(await signer.isAvailable())) return;                      // no hardware → skip
    const { publicKey } = await signer.createKeys();                // silent, no biometric
    const res = await authedFetch('/api/v1/authenticator/devices', {
      method: 'POST',
      body: JSON.stringify({ kind: 'mobile_hw_key', publicKey, label: 'This device', isPlatformBound: true }),
    });
    if (!res.ok) return;                                            // fail open, retry later
    const { device } = await res.json();
    if (device?.id) await SecureStore.setItemAsync(CRED_ID_KEY, device.id);
  } catch {
    // fail open — never block login on approver provisioning
  }
}
```

  Then **delete `registerApproverDevice` and `setApproverPin`** (the manual flow + PIN are gone).

- [ ] **Step 4: Run, verify pass.** Same command → PASS.

- [ ] **Step 5: Hook into auth.** In `RootNavigator.tsx`, after a successful `setCredentials`/login (both the fresh-login effect and the restored-session branch at lines ~79/85), `void ensureApproverDevice();`. Import it from `../services/approverDevice`.

- [ ] **Step 6: Delete the setup sheet + wiring.** `git rm apps/mobile/src/screens/approvals/components/ApproverSetupSheet.tsx`. In `SettingsSheet.tsx`, revert this session's additions: the `ApproverSetupSheet` import, the `approverSetupOpen` state, `onPressApproverSetup`, the `<ApproverSetupSheet>` render, the `SheetBody` prop (destructure + type), and the `"Set up Authenticator"` `LinkRow`.

- [ ] **Step 7: Typecheck + tests.** `PATH=…:$PATH npx tsc --noEmit` (in apps/mobile) and `npx vitest run apps/mobile/src/services/approverDevice.test.ts` → both clean. Also delete the now-dead PIN test cases in `approverDevice.test.ts`.

- [ ] **Step 8: Commit.** `git add -A apps/mobile && git commit -m "feat(mobile): auto-provision approver key at login, remove setup sheet + PIN"`

---

## Task 6: Web — list all approver devices (incl. phones)

**Files:**
- Modify: `apps/web/src/components/settings/ApproverDevicesSection.tsx`
- Test: `apps/web/src/components/settings/ApproverDevicesSection.test.tsx`

- [ ] **Step 1: Read the component + test.** Confirm it fetches `/api/v1/me/approver-devices` and currently only renders the browser-registration affordance.

- [ ] **Step 2: Write failing test** (vitest + jsdom; stub `fetchWithAuth`):

```ts
it('lists a registered mobile_hw_key phone alongside the register-this-browser action', async () => {
  fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ devices: [
    { id: 'd1', kind: 'mobile_hw_key', label: 'iPhone 16 Pro', isPlatformBound: true, lastUsedAt: null },
  ] }));
  render(<ApproverDevicesSection />);
  await waitFor(() => screen.getByText('iPhone 16 Pro'));
  expect(screen.getByText(/register this browser/i)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run, verify fail.** `PATH=…:$PATH npx vitest run apps/web/src/components/settings/ApproverDevicesSection.test.tsx -t "lists a registered"` → FAIL.

- [ ] **Step 4: Implement.** Render the fetched `devices[]` as rows (platform/label/last-used/revoke), with a `data-testid="approver-device-<id>"`; keep the "Register this browser with Windows Hello / Touch ID" action below the list as the optional path. Update the empty-state copy to point unregistered users to the mobile app.

- [ ] **Step 5: Run, verify pass.** Same command → PASS.

- [ ] **Step 6: Commit.** `git add apps/web/src/components/settings/ApproverDevicesSection.* && git commit -m "feat(web): list registered approver phones in Approval security"`

---

## Task 7: Migration — drop approver-PIN columns

**Files:**
- Create: `apps/api/migrations/2026-06-15-drop-approver-pin.sql`
- Modify: `apps/api/src/db/schema/users.ts` (remove the column definitions)

- [ ] **Step 1: Identify the columns.** `grep -nE "pin" apps/api/src/db/schema/users.ts` — note exact column names (e.g. `approver_pin_hash`, lockout columns) and the `pin_verified` columns on `approval_requests`/`elevation_requests`.

- [ ] **Step 2: Write the idempotent migration:**

```sql
-- 2026-06-15-drop-approver-pin.sql — PIN removed in favor of L4 re-auth.
ALTER TABLE users DROP COLUMN IF EXISTS approver_pin_hash;
ALTER TABLE users DROP COLUMN IF EXISTS approver_pin_set_at;
ALTER TABLE users DROP COLUMN IF EXISTS approver_pin_failed_count;
ALTER TABLE users DROP COLUMN IF EXISTS approver_pin_locked_until;
ALTER TABLE approval_requests DROP COLUMN IF EXISTS pin_verified;
ALTER TABLE elevation_requests DROP COLUMN IF EXISTS pin_verified;
```

(Match the *actual* column names from Step 1. No inner `BEGIN/COMMIT` — autoMigrate wraps each file.)

- [ ] **Step 3: Remove the columns from `users.ts`** (and the `pin_verified` columns from `approvals.ts`/`elevations.ts` schema).

- [ ] **Step 4: Apply + drift check.** Apply via the dev API restart (autoMigrate) or `tsx`, then `export DATABASE_URL=… && pnpm db:check-drift` → no drift.

- [ ] **Step 5: Commit.** `git add apps/api/migrations apps/api/src/db/schema && git commit -m "feat(authenticator): drop approver-PIN columns"`

---

## Task 8: Full-suite gate + on-device verification

- [ ] **Step 1:** Run the authenticator-touching suites: `authenticatorAssurance.test.ts`, `authenticator.test.ts`, `approverDevice.test.ts`, `ApproverDevicesSection.test.tsx`, plus `approvals`/`pam` tests that referenced PIN. All green.
- [ ] **Step 2:** RLS forge for `authenticator_devices` unchanged → still passes (Integration Tests job).
- [ ] **Step 3:** Typecheck all four packages; 0 new errors.
- [ ] **Step 4 (manual, on-device):** Fresh login on a physical iPhone → no setup step; the phone appears at `/settings/profile` automatically; the first real approval is the first Face ID; a critical approval prompts account re-auth; `decided_via='mobile_hw_key'`.
- [ ] **Step 5: Commit** any test fixups, then the branch is ready to merge #1369 with the redesign folded in.

---

## Self-Review

- **Spec coverage:** registration-at-login (T5), passwordless + PoP-on-first-signature (T4), web lists phones (T6), PIN removal (T1/T2/T7), L3 recency + L4 re-auth (T3), delete setup sheet + revert wiring (T5), sequencing/on-device (T8). All spec sections mapped.
- **Type consistency:** `mobileHwKeyRegisterSchema` (T1) is consumed by the endpoint (T4) and `ensureApproverDevice` body (T5); `CRED_ID_KEY`/`authedFetch` reused from existing `approverDevice.ts`; `APPROVAL_CHALLENGE_TTL_MS` defined once (T3) and used for L3 recency.
- **Placeholders:** none — the only "match the actual names" notes (T3 fixtures, T7 columns) require the engineer to read the named file first, which each step instructs explicitly.
- **Ordering:** validators (T1) → server teardown (T2) → assurance (T3) → endpoint (T4) → mobile (T5) → web (T6) → migration (T7) → gate (T8). Each task is independently committable.
