---
tracking_issue: LanternOps/breeze#6301
---

# Device Move-Org Step-Up — W03: `mfa_src` Assurance-Source JWT Claim — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every user access/refresh token whose `mfa` claim is `true` also carries `mfa_src: 'factor' | 'idp' | 'policy'` saying how that assurance was earned; carry-forward mints propagate it verbatim; nothing reads it yet.

**Architecture:** One optional claim on `TokenPayload`, validated by membership in `verifyToken`, threaded through the single issuer (`issueUserSession`) via `UserSessionIdentity.mfaSrc`. Each of the mint sites sets the value from the same predicate that already decides `mfa`; the five re-mint/refresh sites copy the incoming claim exactly as they already copy `mdid`. Absent = legacy token = read as `policy` by any future consumer.

**Tech Stack:** TypeScript, Hono, `jose`, Vitest. API package only (`apps/api`).

**Spec:** `docs/superpowers/specs/2026-09-18-device-move-org-step-up-design.md` — decision **D6** and the JWT rows of the tests table. This wave is independent of W01/W02.

## Global Constraints

- Claim name on the wire is exactly `mfa_src`; the identity field is `mfaSrc`. Values are exactly `'factor'`, `'idp'`, `'policy'`. Any other wire value is DROPPED by `verifyToken` (never typed through).
- `mfa: false` tokens carry NO `mfa_src` (invite accept, policy-locked logins, IdP-not-attested SSO).
- Carry-forward sites (refresh, passkey re-mints, factor-removal and recovery-rotation re-mints) propagate `auth.token.mfa_src` / `payload.mfa_src` verbatim and NEVER recompute.
- No consumer: `requireMfa()`, `hasSatisfiedMfa()` and the middleware do not read the claim in this wave.
- OAuth provider access tokens (`apps/api/src/oauth/`) and viewer tokens (`createViewerAccessToken`) are untouched; `apps/api/src/oauth/provider.test.ts:297` stays as is.
- Every test that pins a value at a mint site is mutation-checked: temporarily change the value at the site, run, observe red, revert, run, observe green. The plan shows the exact mutation per task.
- Run one file at a time: `cd apps/api && npx vitest run <path>` (never `pnpm … test -- --run`).
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| File | Responsibility in this wave |
|---|---|
| `apps/api/src/services/jwt.ts` | `TokenPayload.mfa_src` type + doc; `verifyToken` membership-validated rebuild |
| `apps/api/src/services/jwt.test.ts` | round-trip, absent, unknown-value drop |
| `apps/api/src/services/userSession.ts` | `UserSessionIdentity.mfaSrc`; `issueUserSession` passes `mfa_src` |
| `apps/api/src/services/userSession.test.ts` | identity → token round-trip |
| `apps/api/src/services/mfaEnrollmentSession.ts` | `completeInitialMfaEnrollment` guard also requires `mfaSrc === 'factor'` |
| `apps/api/src/routes/auth/login.ts` | password login (`policy`), refresh (carry) |
| `apps/api/src/routes/auth/verifyEmail.ts` | registration auto-login (`policy`) |
| `apps/api/src/middleware/cfAccessLogin.ts`, `apps/api/src/routes/auth/cfAccessRedirectLogin.ts` | CF Access (`idp` / `policy`) |
| `apps/api/src/routes/sso.ts`, `apps/api/src/routes/auth/ssoLinkCompletion.ts` | SSO (`idp`), link ceremony (`factor` / `idp`) |
| `apps/api/src/routes/auth/passkeys.ts`, `apps/api/src/routes/auth/mfa.ts` | factor mints (`factor`), re-mints (carry) |
| `apps/api/src/routes/auth/invite.ts` | `mfa:false`, no claim (assert only) |
| `docs/security/SECURITY.md` | one paragraph under the MFA-assured-session note |

Shared helper introduced in Task 3 and used by every later task:

```ts
// apps/api/src/services/mfaAssuranceSource.ts
export type MfaAssuranceSource = 'factor' | 'idp' | 'policy';
export const MFA_ASSURANCE_SOURCES: readonly MfaAssuranceSource[] = ['factor', 'idp', 'policy'];
export function isMfaAssuranceSource(value: unknown): value is MfaAssuranceSource {
  return typeof value === 'string' && (MFA_ASSURANCE_SOURCES as readonly string[]).includes(value);
}
/** `mfa_src` for a mint whose `mfa` is `assured`: absent when not assured. */
export function mfaSrcFor(assured: boolean, source: MfaAssuranceSource): MfaAssuranceSource | undefined {
  return assured ? source : undefined;
}
```

---

### Task 1: `TokenPayload.mfa_src` + `verifyToken` membership-validated rebuild

**Files:**
- Create: `apps/api/src/services/mfaAssuranceSource.ts`
- Modify: `apps/api/src/services/jwt.ts:206-208` (type), `apps/api/src/services/jwt.ts:322` (verify rebuild)
- Test: `apps/api/src/services/jwt.test.ts` (new describe after `mobile device binding claim (mdid)`, line ~148)

**Interfaces:**
- Produces: `TokenPayload.mfa_src?: 'factor' | 'idp' | 'policy'`; `isMfaAssuranceSource(value: unknown): value is MfaAssuranceSource`; `mfaSrcFor(assured: boolean, source: MfaAssuranceSource): MfaAssuranceSource | undefined`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('jwt service', …)` right after the `mdid` describe block (`jwt.test.ts:~148`):

```ts
  describe('mfa assurance-source claim (mfa_src) — spec D6', () => {
    it('round-trips mfa_src through access and refresh tokens', async () => {
      const access = await verifyToken(await createAccessToken({ ...testPayload, mfa: true, mfa_src: 'factor' }));
      const refresh = await verifyToken(await createRefreshToken({ ...testPayload, mfa: true, mfa_src: 'idp' }));
      expect(access?.mfa_src).toBe('factor');
      expect(refresh?.mfa_src).toBe('idp');
    });

    it('leaves mfa_src undefined on a token minted without it (legacy = policy by contract)', async () => {
      const decoded = await verifyToken(await createAccessToken(testPayload));
      expect(decoded?.mfa_src).toBeUndefined();
      expect('mfa_src' in (decoded ?? {})).toBe(true); // key present, value undefined — same shape as mdid
    });

    it('drops an unknown mfa_src value instead of typing it through', async () => {
      const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
      const forged = await new SignJWT({ ...testPayload, mfa: true, mfa_src: 'bogus', type: 'access' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('15m')
        .setIssuer('breeze')
        .setAudience('breeze-api')
        .sign(secret);
      const decoded = await verifyToken(forged);
      expect(decoded).not.toBeNull();
      expect(decoded?.mfa).toBe(true);
      expect(decoded?.mfa_src).toBeUndefined();
    });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/jwt.test.ts -t "mfa_src"`
Expected: FAIL — TypeScript error `Object literal may only specify known properties, and 'mfa_src' does not exist` (vitest reports as a transform/type failure) or, if esbuild strips types, the round-trip test fails with `expected undefined to be 'factor'`.

- [ ] **Step 3: Create the helper module**

```ts
// apps/api/src/services/mfaAssuranceSource.ts
/**
 * How a session's `mfa: true` claim was earned (spec 2026-09-18 device
 * move-org step-up, D6). Groundwork only — no gate reads this yet.
 *
 *   factor — Breeze itself verified a factor in this session's lineage
 *            (TOTP / SMS / recovery-code login, passkey login, enrollment
 *            mints, the Breeze-verified arm of the SSO link ceremony).
 *   idp    — `mfa: true` rests on a TRUSTED EXTERNAL assertion (CF Access
 *            `trustsMfa`, SSO `trustsIdpMfa` + amr).
 *   policy — `mfa: true` because the effective MFA policy did not require a
 *            factor (password login, registration auto-login, the
 *            no-factor/policy-not-required arms of CF Access and SSO).
 *
 * A token with NO `mfa_src` predates this claim; any consumer MUST read
 * absent as `policy` (the conservative reading). `mfa: false` tokens carry
 * no `mfa_src` at all.
 */
export type MfaAssuranceSource = 'factor' | 'idp' | 'policy';

export const MFA_ASSURANCE_SOURCES: readonly MfaAssuranceSource[] = ['factor', 'idp', 'policy'];

export function isMfaAssuranceSource(value: unknown): value is MfaAssuranceSource {
  return typeof value === 'string' && (MFA_ASSURANCE_SOURCES as readonly string[]).includes(value);
}

/** The claim to mint alongside `mfa: assured`: the source when assured, else absent. */
export function mfaSrcFor(assured: boolean, source: MfaAssuranceSource): MfaAssuranceSource | undefined {
  return assured ? source : undefined;
}
```

- [ ] **Step 4: Add the claim to `TokenPayload` and to `verifyToken`**

In `apps/api/src/services/jwt.ts`, add the import at the top of the file:

```ts
import { isMfaAssuranceSource, type MfaAssuranceSource } from './mfaAssuranceSource';
```

Replace lines 206-208:

```ts
  // Indicates whether this token was issued after completing MFA.
  // For legacy tokens that predate this claim, verification defaults this to false.
  mfa: boolean;
```

with:

```ts
  // Indicates whether this token was issued after completing MFA.
  // For legacy tokens that predate this claim, verification defaults this to false.
  mfa: boolean;
  // HOW `mfa: true` was earned — 'factor' (Breeze verified one), 'idp' (a
  // trusted external assertion), 'policy' (the effective policy required
  // none). See services/mfaAssuranceSource.ts. Absent on every token minted
  // before this claim shipped and on every `mfa: false` token; consumers MUST
  // read absent as 'policy'. Carry-forward mints (refresh, factor re-mints)
  // copy it verbatim — never recompute. No gate reads it yet (spec D6).
  mfa_src?: MfaAssuranceSource;
```

In `verifyToken` (line 322), after `mfa: payload.mfa === true,` insert:

```ts
      mfa_src: isMfaAssuranceSource(payload.mfa_src) ? payload.mfa_src : undefined,
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/jwt.test.ts`
Expected: PASS, all cases in the file.

- [ ] **Step 6: Mutation check**

Temporarily change the new `verifyToken` line to `mfa_src: payload.mfa_src as MfaAssuranceSource | undefined,`. Run the file. Expected: the "drops an unknown mfa_src value" case FAILS (`expected 'bogus' to be undefined`). Revert. Run again. Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json
cd ../.. && git add apps/api/src/services/mfaAssuranceSource.ts apps/api/src/services/jwt.ts apps/api/src/services/jwt.test.ts
git commit -m "feat(auth): add optional mfa_src assurance-source claim to TokenPayload

Membership-validated in verifyToken; unknown wire values are dropped. No
mint site sets it yet and nothing reads it (spec D6, W03 task 1).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `UserSessionIdentity.mfaSrc` threaded through `issueUserSession`

**Files:**
- Modify: `apps/api/src/services/userSession.ts:21-29` (identity type), `:121-131` (createTokenPair field list)
- Test: `apps/api/src/services/userSession.test.ts` (new case after line 128, inside `describe('guarded user-session issuance')`)

**Interfaces:**
- Consumes: `TokenPayload.mfa_src` (Task 1).
- Produces: `UserSessionIdentity.mfaSrc?: MfaAssuranceSource`. Every mint site in Tasks 4-8 sets this field; every carry-forward site copies it from `auth.token?.mfa_src` / `payload.mfa_src`.

- [ ] **Step 1: Write the failing test**

Add inside `describe('guarded user-session issuance', …)` in `userSession.test.ts`, after the test ending at line 128:

```ts
  it('signs the identity mfaSrc into both tokens as mfa_src, and omits it when the identity has none', async () => {
    const withSource = transactionHarness([[{ status: 'active', authEpoch: 8, mfaEpoch: 13 }]]);
    const issued = await issueUserSession({ ...identity, mfaSrc: 'factor' }, {
      tx: withSource.tx,
      capability,
      expectedEpochs: { authEpoch: 8, mfaEpoch: 13 },
    });
    await expect(verifyToken(issued.accessToken)).resolves.toMatchObject({ mfa: true, mfa_src: 'factor' });
    await expect(verifyToken(issued.refreshToken)).resolves.toMatchObject({ mfa: true, mfa_src: 'factor' });

    const withoutSource = transactionHarness([[{ status: 'active', authEpoch: 8, mfaEpoch: 13 }]]);
    const legacyShaped = await issueUserSession({ ...identity, mfa: false }, {
      tx: withoutSource.tx,
      capability,
      expectedEpochs: { authEpoch: 8, mfaEpoch: 13 },
    });
    const access = await verifyToken(legacyShaped.accessToken);
    expect(access?.mfa).toBe(false);
    expect(access?.mfa_src).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/userSession.test.ts -t "mfaSrc"`
Expected: FAIL — `expected { … mfa: true } to match object { mfa_src: 'factor' }` (the issuer does not forward the field).

- [ ] **Step 3: Thread the field**

In `apps/api/src/services/userSession.ts` add the import:

```ts
import type { MfaAssuranceSource } from './mfaAssuranceSource';
```

Change the identity type (lines 21-29) to:

```ts
export type UserSessionIdentity = Readonly<{
  userId: string;
  email: string;
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
  scope: 'system' | 'partner' | 'organization';
  mfa: boolean;
  /** How `mfa: true` was earned. Omit when `mfa` is false. See services/mfaAssuranceSource.ts. */
  mfaSrc?: MfaAssuranceSource;
  mobileDeviceId?: string;
}>;
```

In the `createTokenPair({...})` call (lines 121-131) add one line after `mfa: identity.mfa,`:

```ts
    mfa_src: identity.mfaSrc,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/userSession.test.ts src/services/userSession.callers.test.ts src/services/userSession.types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/userSession.ts apps/api/src/services/userSession.test.ts
git commit -m "feat(auth): thread UserSessionIdentity.mfaSrc into the issued token pair

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Test-harness forwarders + `completeInitialMfaEnrollment` guard

Several route suites mock `issueUserSession` by rebuilding the `createTokenPair` payload by hand, so `mfa_src` would never reach their captured payload. Fix the forwarders once, then tighten the enrollment guard.

**Files:**
- Modify: `apps/api/src/routes/auth/login.test.ts:140-150` (`issueUserSession` forwarder in the `'../../services'` mock), `apps/api/src/routes/auth/login.test.ts:60-70` (`legacyIssuer` forwarder)
- Modify: `apps/api/src/middleware/cfAccessLogin.test.ts:152-166` (`issueLegacy` forwarder)
- Modify: `apps/api/src/routes/auth/cfAccessRedirectLogin.test.ts:271,281` (`lastTokenPayload` capture)
- Modify: `apps/api/src/routes/auth.test.ts` and `apps/api/src/routes/auth.passkeys.test.ts` `issueLegacy` forwarders (find with `grep -n "mdid: identity.mobileDeviceId" apps/api/src/routes/auth.test.ts apps/api/src/routes/auth.passkeys.test.ts`)
- Modify: `apps/api/src/services/mfaEnrollmentSession.ts:299-301`
- Test: `apps/api/src/services/mfaEnrollmentSession.test.ts` (new case near the `'carries a non-assured caller claim forward'` case at line 346)

**Interfaces:**
- Consumes: `UserSessionIdentity.mfaSrc` (Task 2).
- Produces: in every listed suite, the captured `createTokenPair` payload / `lastTokenPayload` includes `mfa_src` when the identity carried `mfaSrc`.

- [ ] **Step 1: Write the failing guard test**

In `mfaEnrollmentSession.test.ts`, next to the existing `'carries a non-assured caller claim forward'` case, add:

```ts
  it('completeInitialMfaEnrollment refuses an identity that is assured but not factor-sourced', async () => {
    await expect(completeInitialMfaEnrollment({
      userId: identity.userId,
      identity: { ...identity, mfa: true, mfaSrc: 'policy' },
      capability,
      expectedAuthEpoch: 3,
      expectedMfaEpoch: 7,
      expectedMfaEnabled: false,
      revokeReason: 'mfa-enroll',
      recoveryCodes: ['code-1'],
      recoveryCodeHashes: ['hash-1'],
      persistFactor: async () => undefined,
    })).rejects.toThrow('Replacement enrollment identity must be factor-sourced');
    expect(issueUserSessionMock).not.toHaveBeenCalled();
  });
```

(If `completeInitialMfaEnrollment` is not yet imported in this test file, add it to the existing import from `./mfaEnrollmentSession`. Match the surrounding tests' `identity`/`capability` fixtures — they are the same objects the neighbouring case uses.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/mfaEnrollmentSession.test.ts -t "factor-sourced"`
Expected: FAIL — promise resolved instead of rejecting (or rejected with a different message).

- [ ] **Step 3: Tighten the guard**

In `apps/api/src/services/mfaEnrollmentSession.ts` replace lines 299-301:

```ts
  if (input.identity.mfa !== true) {
    throw new Error('Replacement enrollment identity must be MFA-assured');
  }
```

with:

```ts
  if (input.identity.mfa !== true) {
    throw new Error('Replacement enrollment identity must be MFA-assured');
  }
  // The factor this call installs is what assures the replacement session, so
  // its source can only ever be 'factor' — a caller passing 'policy'/'idp'
  // here has wired the wrong identity (spec D6).
  if (input.identity.mfaSrc !== 'factor') {
    throw new Error('Replacement enrollment identity must be factor-sourced');
  }
```

- [ ] **Step 4: Fix the harness forwarders**

In each listed file, find the hand-built `createTokenPair({ … mfa: identity.mfa, … mdid: identity.mobileDeviceId })` object and add, directly after the `mfa:` line:

```ts
      mfa_src: identity.mfaSrc,
```

Exact spots:
- `login.test.ts` — two forwarders: `legacyIssuer` (line ~60) and `issueUserSession` (line ~140).
- `cfAccessLogin.test.ts` — `issueLegacy` (line ~156).
- `auth.test.ts` and `auth.passkeys.test.ts` — their `issueLegacy` forwarders (located by the grep above).

In `cfAccessRedirectLogin.test.ts`, change both captures (lines 271 and 281):

```ts
    servicesState.lastTokenPayload = { sub: identity.userId, mfa: identity.mfa, mfa_src: identity.mfaSrc };
```

- [ ] **Step 5: Run the touched suites**

Run: `cd apps/api && npx vitest run src/services/mfaEnrollmentSession.test.ts src/routes/auth/login.test.ts src/middleware/cfAccessLogin.test.ts src/routes/auth/cfAccessRedirectLogin.test.ts src/routes/auth.test.ts src/routes/auth.passkeys.test.ts`
Expected: PASS. (The enrollment guard does not break existing enrollment suites because those suites mock `completeInitialMfaEnrollment` wholesale — confirm the run is green; if a suite constructs a real call with `mfa: true` and no `mfaSrc`, add `mfaSrc: 'factor'` to that fixture and note it in the commit body.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/mfaEnrollmentSession.ts apps/api/src/services/mfaEnrollmentSession.test.ts apps/api/src/routes/auth/login.test.ts apps/api/src/middleware/cfAccessLogin.test.ts apps/api/src/routes/auth/cfAccessRedirectLogin.test.ts apps/api/src/routes/auth.test.ts apps/api/src/routes/auth.passkeys.test.ts
git commit -m "test(auth): forward mfaSrc through the mint mocks; enrollment guard requires factor source

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Password login (`policy`) and registration auto-login (`policy`)

**Files:**
- Modify: `apps/api/src/routes/auth/login.ts:670-684` (identity), `apps/api/src/routes/auth/verifyEmail.ts:514-524` (`registrationIdentity`)
- Test: `apps/api/src/routes/auth/login.test.ts` — inside `describe('POST /login — MFA enrollment enforcement via effective policy (SR2-05)')` (line ~808-845); `apps/api/src/__tests__/integration/registerPartnerMfaPolicy.integration.test.ts:229`

**Interfaces:**
- Consumes: `mfaSrcFor`, `UserSessionIdentity.mfaSrc`.

- [ ] **Step 1: Write the failing tests**

In `login.test.ts`, extend the two existing SR2-05 cases:

In `'mints mfa:false and returns mfaEnrollmentRequired:true for an unenrolled user when policy requires MFA'`, after the `createTokenPair` assertion add:

```ts
    // mfa:false ⇒ no assurance source at all.
    expect(issueUserSession).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: false, mfaSrc: undefined }),
      expect.anything(),
    );
```

In `'mints mfa:true and mfaEnrollmentRequired:false as today when policy does not require MFA'`, after the `createTokenPair` assertion add:

```ts
    // Vacuous assurance: the policy admitted a password-only session.
    expect(issueUserSession).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: true, mfaSrc: 'policy' }),
      expect.anything(),
    );
    expect(createTokenPair).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: true, mfa_src: 'policy' }),
      expect.anything(),
    );
```

(`issueUserSession` is already imported in this file — it is asserted at line 754.)

In `registerPartnerMfaPolicy.integration.test.ts` after line 229 (`expect(accessClaims.mfa).toBe(false);`) add:

```ts
    expect(accessClaims.mfa_src).toBeUndefined();
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/auth/login.test.ts -t "SR2-05"`
Expected: FAIL on the `mfaSrc: 'policy'` case (`mfaSrc` missing from the identity).

- [ ] **Step 3: Implement**

`login.ts` — add the import with the other service imports:

```ts
import { mfaSrcFor } from '../../services/mfaAssuranceSource';
```

In the identity object (line ~677) change `mfa: mfaSatisfied,` to:

```ts
    mfa: mfaSatisfied,
    // The enrolled branch returned early above, so anyone minting here proved
    // no factor: `mfa: true` here is policy-admitted, never factor-earned.
    mfaSrc: mfaSrcFor(mfaSatisfied, 'policy'),
```

`verifyEmail.ts` — add the same import and change `registrationIdentity` (line 514):

```ts
function registrationIdentity(facts: RegistrationFacts): UserSessionIdentity {
  return {
    userId: facts.created.adminUserId,
    email: facts.userRow.email,
    roleId: facts.created.adminRoleId,
    orgId: facts.created.orgId,
    partnerId: facts.created.partnerId,
    scope: 'partner',
    mfa: facts.mfaSatisfied,
    // A brand-new partner admin has no factor yet: assurance is policy-admitted.
    mfaSrc: mfaSrcFor(facts.mfaSatisfied, 'policy'),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/auth/login.test.ts src/routes/auth/verifyEmail.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation check**

In `login.ts` change `'policy'` to `'factor'`. Run `npx vitest run src/routes/auth/login.test.ts -t "SR2-05"`. Expected: FAIL (`mfaSrc: 'policy'` not matched). Revert. Run. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/verifyEmail.ts apps/api/src/routes/auth/login.test.ts apps/api/src/__tests__/integration/registerPartnerMfaPolicy.integration.test.ts
git commit -m "feat(auth): mint mfa_src=policy on password login and registration auto-login

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: CF Access (`idp` when the trusted assertion satisfied it, else `policy`)

**Files:**
- Modify: `apps/api/src/middleware/cfAccessLogin.ts:309-312,321-330`, `apps/api/src/routes/auth/cfAccessRedirectLogin.ts:259-271`
- Test: `apps/api/src/middleware/cfAccessLogin.test.ts` (cases at 718-770), `apps/api/src/routes/auth/cfAccessRedirectLogin.test.ts` (cases at 807-850)

**Interfaces:**
- Consumes: `mfaSrcFor`, `MfaAssuranceSource`.

The predicate today is `mfaSatisfied = !ENABLE_2FA || (user.mfaEnabled && trustsMfa) || (!user.mfaEnabled && !policy.required)`. The source is `'idp'` exactly when the middle arm is what made it true; otherwise `'policy'` (this covers the `!ENABLE_2FA` short-circuit too — with 2FA off there is no assurance to describe, and `policy` is the conservative label).

- [ ] **Step 1: Write the failing tests**

`cfAccessLogin.test.ts` — extend three existing cases:

- `'an unenrolled user under a NON-required policy still gets mfa=true'` (line ~718): change the payload assertion to
  ```ts
      expect(tokenState.lastPayload).toMatchObject({ mfa: true, mfa_src: 'policy' });
  ```
- `'CF_ACCESS_TRUSTS_MFA does NOT satisfy a required policy for an unenrolled user (fail closed)'` (line ~736): change to
  ```ts
      expect(tokenState.lastPayload).toMatchObject({ mfa: false });
      expect(tokenState.lastPayload?.mfa_src).toBeUndefined();
  ```
- `'CF_ACCESS_TRUSTS_MFA still satisfies a required policy for an ENROLLED user'` (line ~754): change to
  ```ts
      expect(tokenState.lastPayload).toMatchObject({ mfa: true, mfa_src: 'idp' });
  ```

`cfAccessRedirectLogin.test.ts` — the same three edits on the sibling cases at lines ~807, ~820, ~833, asserting on `servicesState.lastTokenPayload`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/middleware/cfAccessLogin.test.ts src/routes/auth/cfAccessRedirectLogin.test.ts -t "policy|TRUSTS_MFA"`
Expected: FAIL on the `mfa_src` expectations.

- [ ] **Step 3: Implement — middleware**

`cfAccessLogin.ts`: add the import

```ts
import { mfaSrcFor, type MfaAssuranceSource } from '../services/mfaAssuranceSource';
```

Replace lines 309-312:

```ts
  const mfaSatisfied =
    !ENABLE_2FA ||
    (user.mfaEnabled && trustsMfa) ||
    (!user.mfaEnabled && !policy.required);
```

with:

```ts
  const idpSatisfied = ENABLE_2FA && user.mfaEnabled && trustsMfa;
  const mfaSatisfied =
    !ENABLE_2FA ||
    idpSatisfied ||
    (!user.mfaEnabled && !policy.required);
  // 'idp' only when the trusted CF Access assertion is what satisfied an
  // ENROLLED account; the no-factor arm is policy-admitted (spec D6).
  const mfaSource: MfaAssuranceSource = idpSatisfied ? 'idp' : 'policy';
```

In the identity (line ~328) change `mfa: mfaSatisfied,` to:

```ts
      mfa: mfaSatisfied,
      mfaSrc: mfaSrcFor(mfaSatisfied, mfaSource),
```

- [ ] **Step 4: Implement — redirect route**

`cfAccessRedirectLogin.ts`: same import (path `'../../services/mfaAssuranceSource'`), same replacement of the predicate at lines 259-262 (identical code to Step 3), and in the identity (line ~270) change `mfa: mfaSatisfied,` to:

```ts
    mfa: mfaSatisfied,
    mfaSrc: mfaSrcFor(mfaSatisfied, mfaSource),
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/middleware/cfAccessLogin.test.ts src/routes/auth/cfAccessRedirectLogin.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation check**

In `cfAccessLogin.ts` change `idpSatisfied ? 'idp' : 'policy'` to `'idp'`. Run the middleware suite. Expected: the NON-required-policy case FAILS (`'idp'` ≠ `'policy'`). Revert; run; PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/middleware/cfAccessLogin.ts apps/api/src/routes/auth/cfAccessRedirectLogin.ts apps/api/src/middleware/cfAccessLogin.test.ts apps/api/src/routes/auth/cfAccessRedirectLogin.test.ts
git commit -m "feat(auth): mint mfa_src on CF Access logins (idp when the trusted assertion satisfied an enrolled account, else policy)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: SSO callback (`idp`) and SSO link completion (`factor` outranks `idp`)

**Files:**
- Modify: `apps/api/src/routes/sso.ts:3511-3515` (derive source), `:3554-3562` and `:3606-3614` (identities)
- Modify: `apps/api/src/routes/auth/ssoLinkCompletion.ts:174-182` (derive), `:219-227` and `:259-266` (identities)
- Test: `apps/api/src/routes/sso.test.ts:2453-2480` (trustsIdpMfa matrix), `apps/api/src/routes/auth/ssoLinkCompletion.test.ts` (the `breezeMfaVerified: true` case at ~266 and a `breezeMfaVerified: false` case at ~230)

**Interfaces:**
- Consumes: `mfaSrcFor`, `MfaAssuranceSource`.

In `sso.ts`, `ssoMfa = idpMfa && (…)` — every `true` rests on the IdP assertion, so the source is always `'idp'`. In `ssoLinkCompletion.ts`, `ssoMfa = breezeMfaVerified === true || (idpMfa && …)` — a Breeze-verified factor outranks the IdP, so `'factor'` when `breezeMfaVerified`, else `'idp'`.

- [ ] **Step 1: Write the failing tests**

`sso.test.ts` — in `'mints mfa:true when the provider trusts IdP MFA and amr attests it'` (line ~2453) change the assertion to:

```ts
      expect(createTokenPair).toHaveBeenCalledWith(expect.objectContaining({ mfa: true, mfaSrc: 'idp' }), expect.any(Object));
```

(In this suite `createTokenPair` IS `issueUserSessionMock`, so it receives the identity — hence `mfaSrc`, not `mfa_src`; the existing `userId` assertion at line 2243 proves the shape.)

In `'mints mfa:false when the provider trusts IdP MFA but amr does NOT attest it'` (line ~2472) add after the existing assertion:

```ts
      const identity = vi.mocked(createTokenPair).mock.calls.at(-1)?.[0] as { mfaSrc?: string };
      expect(identity.mfaSrc).toBeUndefined();
```

`ssoLinkCompletion.test.ts` — in the case that calls `finalizeSsoPendingLink(c, 'hash-1', { breezeMfaVerified: true, expectedUserId: USER_ID, capability })` (line ~266) add after `expect(outcome.ok).toBe(true);`:

```ts
    expect(issueUserSession).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: true, mfaSrc: 'factor' }),
      expect.anything(),
    );
```

In the first `breezeMfaVerified: false` case that reaches issuance (line ~230, the one asserting `issueUserSession` was called with `scope: 'organization'`) add:

```ts
    // Provider fixture has trustsIdpMfa: false ⇒ not assured ⇒ no source.
    expect(issueUserSession).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: false, mfaSrc: undefined }),
      expect.anything(),
    );
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/sso.test.ts -t "amr attests" ; npx vitest run src/routes/auth/ssoLinkCompletion.test.ts`
Expected: FAIL on `mfaSrc: 'idp'` and `mfaSrc: 'factor'`.

- [ ] **Step 3: Implement — `sso.ts`**

Add the import (next to the other `../services/...` imports):

```ts
import { mfaSrcFor } from '../services/mfaAssuranceSource';
```

After the `ssoMfa` declaration (line 3512-3515) add:

```ts
    // Every `ssoMfa: true` rests on the trusted IdP assertion (spec D6).
    const ssoMfaSrc = mfaSrcFor(ssoMfa, 'idp');
```

In both `sessionIdentity` literals (`:3554-3562` partner axis and `:3606-3614` org axis) change `mfa: ssoMfa` to:

```ts
        mfa: ssoMfa,
        mfaSrc: ssoMfaSrc,
```

- [ ] **Step 4: Implement — `ssoLinkCompletion.ts`**

Add the import (path `'../../services/mfaAssuranceSource'`). After the `ssoMfa` declaration (line 181-182) add:

```ts
  // A Breeze-verified factor from the link ceremony outranks the IdP
  // evaluation for the SOURCE too: 'factor' when Breeze proved it, else the
  // assurance rests on the IdP assertion (spec D6).
  const ssoMfaSrc = mfaSrcFor(ssoMfa, breezeMfaVerified === true ? 'factor' : 'idp');
```

In both `sessionIdentity` literals (`:219-227`, `:259-266`) change `mfa: ssoMfa` to:

```ts
      mfa: ssoMfa,
      mfaSrc: ssoMfaSrc,
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/sso.test.ts src/routes/auth/ssoLinkCompletion.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation check**

In `ssoLinkCompletion.ts` change `breezeMfaVerified === true ? 'factor' : 'idp'` to `'idp'`. Run the link-completion suite. Expected: the `breezeMfaVerified: true` case FAILS. Revert; run; PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/sso.ts apps/api/src/routes/auth/ssoLinkCompletion.ts apps/api/src/routes/sso.test.ts apps/api/src/routes/auth/ssoLinkCompletion.test.ts
git commit -m "feat(auth): mint mfa_src on SSO logins (idp) and the SSO link ceremony (factor outranks idp)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Factor mints (`factor`): passkey login, TOTP/SMS/recovery verify, enrollment identities

**Files:**
- Modify: `apps/api/src/routes/auth/passkeys.ts:378` (initial passkey enrollment identity), `:860` (passkey MFA login identity)
- Modify: `apps/api/src/routes/auth/mfa.ts:552` (`/mfa/verify` login), `:750` and `:1154` (initial-enrollment identities)
- Test: `apps/api/src/routes/auth.passkeys.test.ts:1035,1237`; `apps/api/src/routes/auth.test.ts` (`/auth/mfa/verify` describe at 1425 — the first success case that asserts `createTokenPair`; plus the `completeInitialMfaEnrollment` input assertion at 2285)

**Interfaces:**
- Consumes: `UserSessionIdentity.mfaSrc`; the Task 3 guard now REQUIRES `mfaSrc: 'factor'` on every `completeInitialMfaEnrollment` identity, so the three enrollment identities must be updated together or the real service throws.

- [ ] **Step 1: Write the failing tests**

`auth.passkeys.test.ts` — at line ~1035 and ~1237 change both `createTokenPair` assertions to include the source:

```ts
    expect(createTokenPair).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-123', mfa: true, mfa_src: 'factor' }),
      expect.objectContaining({ refreshFam: 'family-passkey' }),
    );
```

`auth.test.ts` — in the `'POST /auth/mfa/verify — epoch/status-bound pending MFA (SR2-06)'` describe, find the first case that asserts `createTokenPair` was called with `expect.objectContaining({ mfa: true })` (grep `objectContaining({ mfa: true` inside that describe) and extend it to `{ mfa: true, mfa_src: 'factor' }`. At line ~2285 (`expect(completeInitialMfaEnrollment).toHaveBeenCalledTimes(1)`) add:

```ts
      const enrollInput = vi.mocked(completeInitialMfaEnrollment).mock.calls[0]?.[0] as any;
      expect(enrollInput.identity).toMatchObject({ mfa: true, mfaSrc: 'factor' });
```

For the passkey enrollment identity (`passkeys.ts:378`), in `auth.passkeys.test.ts` find the register/verify case that asserts `completeInitialMfaEnrollment` was called (grep `completeInitialMfaEnrollment).toHaveBeenCalled`) and add the same two lines.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/auth.passkeys.test.ts src/routes/auth.test.ts -t "mfa_src|mfaSrc|factor-sourced|passkey"`
Expected: FAIL on the new expectations.

- [ ] **Step 3: Implement**

In each of the five identity literals, directly after `mfa: true,` add:

```ts
          mfaSrc: 'factor',
```

Sites: `passkeys.ts:378` (enrollment), `passkeys.ts:860` (login), `mfa.ts:552` (verify login), `mfa.ts:750` (setup confirm), `mfa.ts:1154` (SMS enable). Keep the indentation of each block. No new import is needed — the literal is typed by `UserSessionIdentity`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/auth.passkeys.test.ts src/routes/auth.test.ts src/routes/auth/mfa.test.ts 2>/dev/null; npx vitest run src/routes/auth.passkeys.test.ts src/routes/auth.test.ts`
Expected: PASS (`routes/auth/mfa.test.ts` does not exist; the `mfa.ts` routes are tested from `routes/auth.test.ts`).

- [ ] **Step 5: Mutation check**

In `passkeys.ts:860` change `'factor'` to `'policy'`. Run `npx vitest run src/routes/auth.passkeys.test.ts -t "passkey"`. Expected: the two login cases FAIL. Revert; run; PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/auth/passkeys.ts apps/api/src/routes/auth/mfa.ts apps/api/src/routes/auth.passkeys.test.ts apps/api/src/routes/auth.test.ts
git commit -m "feat(auth): mint mfa_src=factor on passkey login, MFA verify, and enrollment identities

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Carry-forward sites — refresh, passkey re-mints, factor-removal and recovery-rotation re-mints; invite stays absent

**Files:**
- Modify: `apps/api/src/routes/auth/login.ts:1105-1116` (refresh identity)
- Modify: `apps/api/src/routes/auth/passkeys.ts:448-451` and `:1030-1031` (re-mint identities)
- Modify: `apps/api/src/routes/auth/mfa.ts:938-943` and `:1469-1474` (re-mint identities)
- Test: `apps/api/src/routes/auth/login.test.ts` (`describe('POST /refresh — mfa assurance is carried forward, never elevated')` at line 1574); `apps/api/src/routes/auth.test.ts:4119-4124` and `:4245-4250`; `apps/api/src/routes/auth.passkeys.test.ts:2104-2106`; `apps/api/src/routes/auth/invite.test.ts`

**Interfaces:**
- Consumes: `TokenPayload.mfa_src` on the verified refresh payload / `auth.token`.

- [ ] **Step 1: Write the failing tests — refresh**

In `login.test.ts`'s refresh carry-forward describe (line 1574), change the `postRefresh` helper signature to accept the source and add two cases:

```ts
  async function postRefresh(mfa: boolean, mfa_src?: 'factor' | 'idp' | 'policy') {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'user-1',
      email: 'admin@msp.com',
      type: 'refresh',
      jti: 'jti-current',
      fam: 'family-42',
      aep: 3,
      mep: 1,
      mfa,
      mfa_src,
    } as any);
    return loginRoutes.request('/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-breeze-auth-transition': 'v1' },
    });
  }
```

(Existing calls `postRefresh(false)` / `postRefresh(true)` keep working.) Add:

```ts
  it('carries mfa_src forward verbatim (policy stays policy; a refresh never upgrades to factor)', async () => {
    const res = await postRefresh(true, 'policy');
    expect(res.status).toBe(200);
    expect(issueUserSession).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: true, mfaSrc: 'policy' }),
      expect.anything(),
    );
  });

  it('keeps mfa_src absent on refresh when the incoming token had none (legacy token)', async () => {
    const res = await postRefresh(true);
    expect(res.status).toBe(200);
    expect(issueUserSession).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: true, mfaSrc: undefined }),
      expect.anything(),
    );
  });
```

- [ ] **Step 2: Write the failing tests — re-mints**

`auth.test.ts` line ~4119 (`replaceSessionOnMfaFactorWrite` input for recovery-code rotation) — extend the `input.identity` `toMatchObject` with `mfaSrc: undefined` when the test's auth token carries no source, and add a sibling case in the same describe that seeds the caller's token with `mfa: true, mfa_src: 'policy'` (find how the describe seeds `auth.token` — the SR2 tests set it through the `authMiddleware` mock; copy that describe's `beforeEach` token object, add `mfa_src: 'policy'`) and asserts:

```ts
      expect(input.identity).toMatchObject({ mfa: true, mfaSrc: 'policy' });
```

`auth.test.ts` line ~4245 (`completeMfaFactorRemoval` input for `/mfa/disable`) — same two assertions on `input.identity`.

`auth.passkeys.test.ts` line ~2105 (`completeMfaFactorRemoval` input for passkey delete) — add:

```ts
      expect(input.identity).toMatchObject({ mfa: true, mfaSrc: undefined });
```

and a sibling case whose seeded token carries `mfa_src: 'factor'` asserting `mfaSrc: 'factor'`.

`invite.test.ts` — in the accept-invite success case, add:

```ts
    expect(issueUserSession).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: false, mfaSrc: undefined }),
      expect.anything(),
    );
```

(import `issueUserSession` from `'../../services/userSession'` if the file does not already; if the suite mocks issuance through `'../../services'` instead, assert on that mock's captured identity the same way `cfAccessRedirectLogin.test.ts` does.)

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/auth/login.test.ts -t "carried forward" ; npx vitest run src/routes/auth.test.ts -t "mfaSrc" ; npx vitest run src/routes/auth.passkeys.test.ts -t "mfaSrc"`
Expected: FAIL on the `mfaSrc: 'policy'` / `'factor'` carry cases (identity has no `mfaSrc`).

- [ ] **Step 4: Implement**

`login.ts` refresh identity (line ~1111): change `mfa: ENABLE_2FA ? payload.mfa : false,` to:

```ts
    mfa: ENABLE_2FA ? payload.mfa : false,
    // Carry the assurance SOURCE forward exactly as the binding below: a
    // refresh re-issues what the prior signed token said, never recomputes it,
    // and never upgrades 'policy' to 'factor'. Absent stays absent.
    mfaSrc: ENABLE_2FA && payload.mfa ? payload.mfa_src : undefined,
```

`passkeys.ts:448` and `:1030`, `mfa.ts:938` and `:1469` — after each `mfa: auth.token?.mfa === true,` add:

```ts
          mfaSrc: auth.token?.mfa === true ? auth.token.mfa_src : undefined,
```

(match each block's indentation).

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/auth/login.test.ts src/routes/auth.test.ts src/routes/auth.passkeys.test.ts src/routes/auth/invite.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation check**

In `login.ts` change the refresh line to `mfaSrc: ENABLE_2FA && payload.mfa ? 'factor' : undefined,`. Run `npx vitest run src/routes/auth/login.test.ts -t "carried forward"`. Expected: the `'policy stays policy'` and `'legacy token'` cases FAIL. Revert; run; PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/passkeys.ts apps/api/src/routes/auth/mfa.ts apps/api/src/routes/auth/login.test.ts apps/api/src/routes/auth.test.ts apps/api/src/routes/auth.passkeys.test.ts apps/api/src/routes/auth/invite.test.ts
git commit -m "feat(auth): carry mfa_src forward verbatim on refresh and factor re-mints; invite mints none

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Sweep for stragglers, docs, full-suite verification

**Files:**
- Modify: `docs/security/SECURITY.md` (after the blockquote at line 9)
- Verify only: every remaining `UserSessionIdentity` literal

- [ ] **Step 1: Mechanical sweep**

Run:

```bash
cd apps/api && grep -rn "mfa: \(true\|false\|[a-zA-Z.]*\),$" src/routes src/middleware src/services --include='*.ts' | grep -v "\.test\.ts" | grep -v "details:\|auditLogin\|mfaSatisfied:" 
```

Every hit inside a `UserSessionIdentity` literal must be one of: (a) followed by a `mfaSrc:` line, or (b) `mfa: false` with no source (invite). Known-complete list after Tasks 4-8: `login.ts` ×2, `verifyEmail.ts`, `cfAccessLogin.ts`, `cfAccessRedirectLogin.ts`, `sso.ts` ×2, `ssoLinkCompletion.ts` ×2, `passkeys.ts` ×4, `mfa.ts` ×5, `invite.ts`. Any other hit is a mint site the exploration missed — add `mfaSrc` with the value the site's own `mfa` predicate implies and a test in that site's suite, then note it in the commit body.

- [ ] **Step 2: Docs**

In `docs/security/SECURITY.md`, insert after the blockquote paragraph that begins `> **"MFA-assured session" / \`requireMfa()\`**` (line 9):

```markdown
> Since W03 of the device move-org step-up work, every `mfa: true` token also carries `mfa_src`: `factor` (Breeze verified a factor in this session's lineage), `idp` (a trusted CF Access / SSO assertion), or `policy` (the effective policy required none). Refresh and factor re-mints copy it verbatim and never upgrade it. Tokens minted before the claim shipped have none and MUST be read as `policy`. No gate consumes it yet; it exists so a future "proven factor" check is a predicate on the token, not a plumbing change.
```

- [ ] **Step 3: Full verification**

```bash
cd apps/api
NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json
npx vitest run src/services/jwt.test.ts src/services/userSession.test.ts src/services/mfaEnrollmentSession.test.ts src/routes/auth/login.test.ts src/routes/auth/verifyEmail.test.ts src/middleware/cfAccessLogin.test.ts src/routes/auth/cfAccessRedirectLogin.test.ts src/routes/sso.test.ts src/routes/auth/ssoLinkCompletion.test.ts src/routes/auth.passkeys.test.ts src/routes/auth.test.ts src/routes/auth/invite.test.ts src/oauth/provider.test.ts src/middleware/auth.test.ts
cd ../.. && npx eslint apps/api/src/services/mfaAssuranceSource.ts apps/api/src/services/jwt.ts apps/api/src/services/userSession.ts apps/api/src/routes/auth apps/api/src/routes/sso.ts apps/api/src/middleware/cfAccessLogin.ts
```

Expected: tsc exit 0; every listed suite green, including `oauth/provider.test.ts` (its exact-key-set assertion at line 297 must be untouched); eslint clean.

Then, with a test stack (`pnpm test-stack up` at the repo root, `set -a && . ./.env.test && set +a`):

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/registerPartnerMfaPolicy.integration.test.ts src/__tests__/integration/mfaStepUpGrant.integration.test.ts
cd ../.. && pnpm test-stack down
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add docs/security/SECURITY.md
git commit -m "docs(security): describe the mfa_src assurance-source claim

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage (D6):** type + membership validation (T1); identity threading (T2); three values with the IdP bucket distinct (T5, T6); `mfa:false` carries none (T4 login, T8 invite, T5/T6 negative cases); carry-forward verbatim at refresh, passkey re-mints, removal/rotation re-mints (T8); absent = legacy = policy documented on the type (T1) and in SECURITY.md (T9); OAuth/viewer untouched and pinned by running `oauth/provider.test.ts` (T9); no consumer (nothing in `middleware/auth.ts` changes — `middleware/auth.test.ts` is re-run in T9 to prove it); mutation checks on every gate-like value (T1, T4, T5, T6, T7, T8). The tests-table row "per-site `mfa_src` assertions in login/sso/ssoLinkCompletion/passkeys/cfAccessRedirectLogin/verifyEmail" is covered by T4-T7 (verifyEmail via the integration decode, since its unit suite has no identity capture). "jwt round-trip + unknown-value drop" = T1. "refresh carry-forward" = T8.

**Placeholder scan:** none. Every code step shows the code; every grep is executable.

**Type consistency:** `MfaAssuranceSource`, `mfaSrcFor`, `isMfaAssuranceSource` defined in T1 and used unchanged in T4-T8; wire name `mfa_src`, identity name `mfaSrc` throughout; test mocks forward `mfa_src: identity.mfaSrc` (T3) which is what T4-T8's `createTokenPair` assertions rely on; suites that assert on `createTokenPair` receiving the *identity* (`sso.test.ts`) assert `mfaSrc`, those receiving the *payload* assert `mfa_src`.
