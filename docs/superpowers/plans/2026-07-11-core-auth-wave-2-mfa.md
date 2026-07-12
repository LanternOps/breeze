# Core Authentication Wave 2 MFA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the strictest live MFA policy, bind assurance to the current factor configuration, require existing-factor proof for additions/replacements, and make recovery codes usable exactly once.

**Architecture:** A central policy resolver combines role/partner/org requirements and allowed methods. Wave 1 epochs and lifecycle transactions invalidate assurance after factor or policy changes. Versioned pending-MFA and purpose-bound step-up records provide single-use Redis state; recovery-code consumption uses fail-closed pending consumption plus a row-locked database transaction.

**Tech Stack:** TypeScript, Hono, Drizzle/PostgreSQL, Redis, WebAuthn, TOTP/SMS, React, Vitest.

## Global Constraints

- Wave 1 `auth_epoch`, `mfa_epoch`, `sid`, durable family revocation, and `issueUserSession` are required interfaces.
- Use canonical `security.allowedMethods`; legacy `allowedMfaMethods` is migration input only.
- Required policy uses OR; explicit allowed-method sets use intersection.
- Unenrolled users never receive vacuous `mfa=true`.
- Redis failure burns/denies pending authentication rather than bypassing it.
- Every factor or effective-policy mutation advances `mfa_epoch` and revokes affected families transactionally.
- Never log factor secrets, codes/hashes, WebAuthn assertions, challenges, or public-key material.
- Follow Node/pnpm, migration, RLS, context, and TDD constraints from the parent design.

---

### Task 1: Canonicalize MFA policy and add the strict resolver

**Files:**
- Create: `apps/api/migrations/2026-07-11-b-mfa-assurance.sql`
- Create: `apps/api/src/services/mfaPolicy.ts`
- Create: `apps/api/src/services/mfaPolicy.test.ts`
- Modify: `apps/api/src/routes/orgs.ts`
- Modify: organization/partner settings validators in `packages/shared/src/validators/`
- Modify: associated validator and route tests

**Interfaces:**
- Produces `resolveEffectiveMfaPolicy({ userId, roleId, orgId, partnerId, scope, tx? })`.
- Produces canonical `MfaMethod = 'totp'|'sms'|'passkey'|'recovery_code'`.

- [ ] **Step 1: Write failing policy matrix tests**

```ts
expect(await resolvePolicy({ role: false, partner: true, org: false })).toMatchObject({ required: true });
expect(await resolveAllowed({ partner: ['totp', 'passkey'], org: ['passkey', 'sms'] }))
  .toEqual(new Set(['passkey']));
```

Cover absent levels, each require source, intersection, empty-intersection rejection, partner/org axes, missing/inactive membership, recovery-code behavior, and canonical/legacy settings input.

- [ ] **Step 2: Run RED**

Run: `corepack pnpm --dir apps/api exec vitest run src/services/mfaPolicy.test.ts --maxWorkers=1 --fileParallelism=false`
Expected: FAIL because the resolver does not exist and current settings use inconsistent names.

- [ ] **Step 3: Add migration and validators**

The migration increments every `users.mfa_epoch` once to invalidate Wave 1 tokens without trustworthy AMR. It copies legacy JSON `allowedMfaMethods` into `allowedMethods` only when canonical is absent, removes the legacy key, and reports affected rows through `GET DIAGNOSTICS` warnings.

- [ ] **Step 4: Implement strictest-policy resolution**

Read role/partner/org state under the supplied transaction or correctly escaped system context. Unspecified allowlists impose no restriction; explicit sets intersect. Reject an explicit empty result at settings write time.

- [ ] **Step 5: Run GREEN, drift, and validator tests**

Run the policy suite, relevant shared validator suite, `corepack pnpm db:check-drift`, and API build; expected all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-07-11-b-mfa-assurance.sql apps/api/src/services/mfaPolicy.ts apps/api/src/services/mfaPolicy.test.ts apps/api/src/routes/orgs.ts packages/shared/src/validators
git commit -m "fix(mfa): centralize effective MFA policy"
```

### Task 2: Add trustworthy AMR and request enforcement

**Files:**
- Modify: `apps/api/src/services/jwt.ts`
- Modify: `apps/api/src/services/jwt.test.ts`
- Modify: `apps/api/src/services/userSession.ts`
- Modify: `apps/api/src/middleware/auth.ts`
- Modify: `apps/api/src/middleware/auth.test.ts`
- Modify: all Wave 1 session issuer callers that select MFA outcome

**Interfaces:**
- Adds required `amr: AuthenticationMethod[]` to user tokens.
- Middleware consumes live effective policy plus `mfa`, `amr`, and `mfa_epoch`.

- [ ] **Step 1: Write failing AMR tests**

Test missing AMR rejection, password-only, password+TOTP/SMS/passkey/recovery, trusted IdP MFA, and refresh preservation. Test required policy rejects password-only/untrustworthy AMR and disallowed methods.

- [ ] **Step 2: Run RED**

Run JWT, session, and auth middleware suites; expected missing claim/policy failures.

- [ ] **Step 3: Implement typed AMR issuance**

```ts
export type AuthenticationMethod =
  | 'password' | 'totp' | 'sms' | 'passkey' | 'recovery_code' | 'sso' | 'cf_access';
```

Require every issuer to supply its verified methods. Refresh copies only signed AMR after live epoch/policy validation. Do not infer MFA merely from `users.mfaEnabled`.

- [ ] **Step 4: Enforce policy before RLS dispatch**

Resolve policy after live membership and epoch checks. Required policy demands a factor AMR. Explicit allowed methods require the factor AMR to remain allowed. Forced enrollment returns 428 only on the narrow enrollment/logout paths.

- [ ] **Step 5: Run GREEN and issuer regression suites**

Run JWT/session/middleware plus login, SSO, CF Access, invite, registration, MFA, and passkey tests; expected all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/jwt.ts apps/api/src/services/jwt.test.ts apps/api/src/services/userSession.ts apps/api/src/middleware/auth.ts apps/api/src/middleware/auth.test.ts apps/api/src/routes apps/api/src/middleware/cfAccessLogin.ts
git commit -m "fix(mfa): bind sessions to verified authentication methods"
```

### Task 3: Replace pending MFA with single-use version 2 state

**Files:**
- Create: `apps/api/src/services/mfaAssurance.ts`
- Create: `apps/api/src/services/mfaAssurance.test.ts`
- Modify: `apps/api/src/routes/auth/login.ts`
- Modify: `apps/api/src/routes/auth/mfa.ts`
- Modify: `apps/api/src/routes/auth/passkeys.ts`
- Modify: `apps/api/src/routes/auth.test.ts`
- Modify: `apps/api/src/routes/auth.passkeys.test.ts`

**Interfaces:**
- Produces `createPendingMfa`, `readPendingMfa`, and `consumePendingMfa` for version 2 records.

- [ ] **Step 1: Write failing state tests**

Test auth/mfa epoch, active status, allowed/enrolled methods, primary method, TTL, malformed/legacy record rejection, Redis unavailable, and two concurrent consumers with one winner.

- [ ] **Step 2: Run RED**

Run assurance and auth route tests; expected legacy state/current GET-then-DEL behavior to fail.

- [ ] **Step 3: Implement the record and atomic consume**

Write JSON version 2 with five-minute TTL. Factor routes may read for presentation/verification, but immediately before token issuance they atomically `GETDEL` and compare the returned record with the originally verified state. Any mismatch/absence fails closed.

- [ ] **Step 4: Consolidate post-factor issuance**

Create one helper that reloads active user/policy/epochs and calls `issueUserSession` with correct AMR. TOTP, SMS, and passkey paths use it.

- [ ] **Step 5: Run GREEN**

Run Step 2 suites including status/password/epoch/policy mutation cases; expected all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/mfaAssurance.ts apps/api/src/services/mfaAssurance.test.ts apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/mfa.ts apps/api/src/routes/auth/passkeys.ts apps/api/src/routes/auth.test.ts apps/api/src/routes/auth.passkeys.test.ts
git commit -m "fix(mfa): bind pending challenges to live assurance"
```

### Task 4: Add purpose-bound existing-factor step-up

**Files:**
- Modify: `apps/api/src/routes/auth/helpers.ts`
- Modify: `apps/api/src/routes/auth/helpers.mfaStepUp.test.ts`
- Modify: `apps/api/src/routes/auth/passkeys.ts`
- Modify: `apps/api/src/routes/auth.passkeys.test.ts`
- Modify: `apps/api/src/services/passkeys.ts`
- Modify: `apps/api/src/services/passkeys.test.ts`
- Modify: `apps/api/src/routes/auth/schemas.ts`

**Interfaces:**
- Produces `issueMfaStepUpGrant` and `consumeMfaStepUpGrant` bound to purpose, user, `sid`, auth epoch, and MFA epoch.

- [ ] **Step 1: Write failing grant tests**

Cover no-factor initial setup, existing-factor requirement, TOTP/SMS/passkey proof, wrong purpose/user/session/epoch, TTL, replay, and Redis failure.

- [ ] **Step 2: Write failing passkey binding tests**

Options without a grant on an already protected account fail; verify requires the same enrollment authorization/challenge; a grant cannot be reused for another credential.

- [ ] **Step 3: Run RED**

Run helper/passkey route/service suites; expected current password-only registration to fail the new assertion.

- [ ] **Step 4: Implement hashed random grants and challenge binding**

Generate at least 256 random bits, store by SHA-256 hash for five minutes, and consume only after exact binding checks. Initial enrollment still requires current password. Never allow the candidate new factor to prove its own addition.

- [ ] **Step 5: Run GREEN and commit**

Run Step 3 suites; then:

```bash
git add apps/api/src/routes/auth/helpers.ts apps/api/src/routes/auth/helpers.mfaStepUp.test.ts apps/api/src/routes/auth/passkeys.ts apps/api/src/routes/auth.passkeys.test.ts apps/api/src/services/passkeys.ts apps/api/src/services/passkeys.test.ts apps/api/src/routes/auth/schemas.ts
git commit -m "fix(mfa): require existing-factor proof for enrollment"
```

### Task 5: Make factor and policy mutations invalidate assurance

**Files:**
- Modify: `apps/api/src/routes/auth/mfa.ts`
- Modify: `apps/api/src/routes/auth/phone.ts`
- Modify: `apps/api/src/routes/auth/passkeys.ts`
- Modify: `apps/api/src/routes/orgs.ts`
- Modify: `apps/api/src/services/authLifecycle.ts`
- Reuse: `apps/api/src/services/mfaAssuranceLocks.ts`
- Modify: `apps/api/src/services/remoteSessionTeardown.ts` only if an adapter is needed
- Modify: corresponding API route tests

**Interfaces:**
- Consumes Wave 1 lifecycle primitives inside factor/settings transactions.
- Must consume `lockMfaAssuranceState` before mutation. The production lock
  contract is mandatory and ordered: partner MFA-policy advisory lock → user
  row → passkey/factor rows. Task 5 must not reproduce these locks ad hoc or
  acquire them in another order.
- Produces `{ success: true, reauthenticate: true }` after user factor mutations.

- [ ] **Step 1: Write failing mutation tests**

Cover TOTP setup/replace/disable, SMS enable/phone replace, passkey add/delete, recovery rotation, org policy change, partner policy change, rollback, and remote teardown partial failure. Assert factor/settings state + epoch + family revocation are atomic. Add real-driver races between pending/session issuance and factor or effective-policy mutation in both winner orders; assert stale assurance never issues. Add a two-transaction lock-order regression that proves issuance and mutation complete without deadlock because both acquire partner policy → user → factor rows in the shared order.

- [ ] **Step 2: Run RED**

Run auth/passkey/org route tests; expected current mutation-only behavior to fail epoch/family assertions.

- [ ] **Step 3: Implement transactional user mutations**

Inside the request transaction, call `lockMfaAssuranceState(tx, { partnerId, userId })` before changing any factor, incrementing `mfa_epoch`, or revoking user families. Then change the factor, advance the epoch, and revoke all user families atomically. After commit clear Redis/permission caches and terminate remote sessions. Return reauthentication signal; no old cookie remains usable.

- [ ] **Step 4: Implement policy bulk invalidation**

In the same transaction as the settings update, acquire the partner MFA-policy advisory lock first, then lock affected user rows and factor rows in stable user-id order using the shared contract before incrementing `mfa_epoch` and revoking families for every affected current member. Partner policy applies to partner members and organization members under the partner; organization policy applies to that organization's members. Use set-based SQL where it preserves this lock order and report affected counts in audit.

- [ ] **Step 5: Consume the setup TOTP step**

Replace non-consuming setup verification with `consumeMFAToken(secret, code, userId)` and add immediate replay regression.

- [ ] **Step 6: Run GREEN and commit**

Run Step 2 plus MFA service tests; then commit changed files with `fix(mfa): invalidate assurance after security changes`.

### Task 6: Implement single-use recovery-code login

**Files:**
- Modify: `apps/api/src/routes/auth/schemas.ts`
- Modify: `apps/api/src/routes/auth/mfa.ts`
- Modify: `apps/api/src/routes/auth/helpers.ts`
- Create: `apps/api/src/services/recoveryCodeAuth.ts`
- Create: `apps/api/src/services/recoveryCodeAuth.test.ts`
- Create: `apps/api/src/__tests__/integration/mfa-recovery-code.integration.test.ts`

**Interfaces:**
- Produces `consumeRecoveryCode(userId, code, tx)` returning remaining count and new MFA epoch.

- [ ] **Step 1: Write failing schema/service tests**

Use a discriminated schema for `method:'recovery_code'` and `XXXX-XXXX`; test normalization, wrong/missing/replay, no pending session, row lock, and audit redaction.

- [ ] **Step 2: Write failing concurrent real-DB test**

Submit the same pending state/code concurrently and assert exactly one token response and one stored-hash removal.

- [ ] **Step 3: Run RED**

Run schema/service and integration tests; expected no route/consumer to exist.

- [ ] **Step 4: Implement fail-closed ordering**

Atomically consume the pending MFA record first. In a system-scoped DB transaction, lock the user row, normalize/hash, remove exactly one match, advance `mfa_epoch`, revoke old families, and return new epochs. Mint a fresh session only after commit with `amr=['password','recovery_code']`. A DB failure burns the pending login and issues no token.

- [ ] **Step 5: Run GREEN and commit**

Run Step 3 tests; commit API/service/integration files with `fix(mfa): support single-use recovery-code login`.

### Task 7: Update web/mobile MFA contracts and verify Wave 2

**Files:**
- Modify: `apps/web/src/stores/auth.ts`
- Modify: `apps/web/src/components/auth/LoginPage.tsx`
- Modify: `apps/web/src/components/auth/MFAVerifyForm.tsx`
- Modify: `apps/web/src/components/settings/OrgSecuritySettings.tsx`
- Modify: `apps/web/src/components/settings/PartnerSecurityTab.tsx`
- Modify: related web tests and `apps/web/src/locales/en/*.json`, `pt-BR/*.json`
- Modify: `apps/mobile/src/services/api.ts`
- Modify: `apps/mobile/src/screens/auth/MfaChallengeScreen.tsx`
- Modify: related mobile tests
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write failing UI/store tests**

Test recovery-code selection/format, allowed methods, required-policy enrollment, passkey step-up, and `reauthenticate:true` clearing local state.

- [ ] **Step 2: Run RED**

Run the narrow web/mobile suites; expected missing recovery and reauthentication behavior.

- [ ] **Step 3: Implement client contracts and localized copy**

Use existing auth store APIs; add method-safe payloads; never persist recovery codes. After factor mutation clear tokens and navigate to login with a security-settings-changed notice.

- [ ] **Step 4: Run complete Wave 2 gates**

```bash
corepack pnpm --dir apps/api exec vitest run src/services/mfa.test.ts src/services/mfaPolicy.test.ts src/services/mfaAssurance.test.ts src/services/recoveryCodeAuth.test.ts src/services/passkeys.test.ts src/middleware/auth.test.ts src/routes/auth.test.ts src/routes/auth.passkeys.test.ts src/routes/auth/schemas.test.ts --maxWorkers=1 --fileParallelism=false
corepack pnpm --filter @breeze/api build
corepack pnpm --filter @breeze/web build
corepack pnpm db:check-drift
corepack pnpm --dir apps/api run test:rls-coverage
```

Run the real-DB recovery concurrency test separately and require one winner.

- [ ] **Step 5: Independent review and commit**

Review policy strictness, all factor mutations, cross-store ordering, secret redaction, and every client reauthentication path. Commit UI/mobile/release-note changes with `feat(mfa): expose hardened recovery and policy flows`.
