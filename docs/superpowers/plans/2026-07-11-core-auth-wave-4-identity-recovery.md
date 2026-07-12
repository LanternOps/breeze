# Core Authentication Wave 4 Identity Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind email/reset artifacts to exact generations, require fresh MFA for recovery-address changes, create accounts only after email verification, and eliminate registration/reset/lockout enumeration.

**Architecture:** Durable user epochs gate reset and email artifacts. Pending registration is a separate Redis lifecycle because no user exists yet. A dedicated BullMQ worker performs conditional email/account work outside public request timing. Wave 1 transactions revoke sessions; Wave 2 step-up authorizes email changes.

**Tech Stack:** TypeScript, Hono, Drizzle/PostgreSQL, Redis/BullMQ, React/Astro, Vitest.

## Global Constraints

- Require Wave 1 lifecycle and Wave 2 `email.change` step-up interfaces.
- Current verified email remains authoritative until pending email confirmation commits.
- Advance reset generation before writing Redis artifacts; partial failure invalidates older tokens.
- Pending registration and pending email are distinct artifacts.
- Public sameness includes HTTP status, body, and synchronous work.
- Do not hold DB transactions across email, Redis queue, or other outbound work.
- Do not place PII/password hashes/raw tokens in BullMQ job data or logs.

---

### Task 1: Add pending-email and verification-generation schema

**Files:**
- Create: `apps/api/migrations/2026-07-11-d-core-auth-email-recovery.sql`
- Modify: `apps/api/src/db/schema/users.ts`
- Modify: `apps/api/src/db/schema/emailVerificationTokens.ts`
- Modify: schema barrel/tests and `apps/api/src/db/autoMigrate.test.ts`

**Interfaces:**
- Adds `users.pendingEmail`, `pendingEmailRequestedAt`.
- Adds verification `purpose` and `emailEpoch`.

- [ ] Write failing schema tests for pending fields and exact-purpose epoch tokens.
- [ ] Run RED.
- [ ] Add idempotent migration; invalidate legacy unconsumed verification tokens in a counted cleanup block; retain current RLS policies.
- [ ] Map Drizzle fields and run GREEN, drift, migration, and RLS tests.
- [ ] Commit with `fix(auth): add generation-bound email verification state`.

### Task 2: Implement password-reset generations

**Files:**
- Create: `apps/api/src/services/passwordReset.ts`
- Create: `apps/api/src/services/passwordReset.test.ts`
- Modify: `apps/api/src/routes/auth/password.ts`
- Modify: `apps/api/src/routes/auth/password.test.ts`
- Modify: `apps/api/src/services/passwordResetEligibility.ts`
- Create/modify: `apps/api/src/__tests__/integration/coreAuthEmailRecovery.integration.test.ts`

**Interfaces:**
- Produces `issuePasswordReset(userId,email)` and `consumePasswordReset(rawToken,newPassword)`.

- [ ] Write failing tests for newer-token supersession, password/email generation mismatch, ordinary password change, replay/concurrency, exact normalized email, Redis failure, and transaction rollback.
- [ ] Run RED on service/route/integration tests.
- [ ] Issuance transaction increments `password_reset_epoch`; only afterward store `{userId,normalizedEmail,passwordResetEpoch,emailEpoch}` under SHA-256 token hash for one hour. Redis failure leaves the new generation advanced.
- [ ] Consumption `GETDEL`s, reloads eligibility, and transactionally changes password, advances auth/reset epochs, and revokes families. Ordinary password change uses the same lifecycle operation.
- [ ] Run GREEN and commit with `fix(auth): supersede password reset generations`.

### Task 3: Add the authentication email queue

**Files:**
- Create: `apps/api/src/jobs/authEmailWorker.ts`
- Create: `apps/api/src/jobs/authEmailWorker.test.ts`
- Modify: `apps/api/src/services/bullmqQueue.ts` only for shared typed helper needs
- Modify: `apps/api/src/index.ts`
- Modify: runtime shutdown/worker initialization tests

**Interfaces:**
- Produces typed forgot-password, registration-verification, pending-email, and changed-email jobs carrying opaque request IDs only.

- [ ] Write failing worker/startup/shutdown tests for eligible/ineligible paths, retry/backoff, unavailable Redis/email, redacted job/log data, and no DB transaction across email.
- [ ] Run RED.
- [ ] Implement `createInstrumentedQueue`, Worker lifecycle, bounded retries/backoff/removal, opaque Redis envelopes, and startup/shutdown wiring following `warrantyWorker.ts`.
- [ ] Run GREEN and commit with `feat(auth): add asynchronous authentication email jobs`.

### Task 4: Convert email change to pending confirmation

**Files:**
- Modify: `apps/api/src/routes/users.ts`
- Modify: `apps/api/src/routes/users.test.ts`
- Modify: `apps/api/src/services/emailVerification.ts`
- Modify: `apps/api/src/services/emailVerification.test.ts`
- Modify: `apps/api/src/routes/auth/verifyEmail.ts`
- Modify: `apps/api/src/routes/auth/verifyEmail.test.ts`
- Modify: `apps/api/src/middleware/auth.ts`

**Interfaces:**
- Request consumes Wave 2 `email.change` grant and writes pending state.
- Verification swaps email and revokes sessions atomically.

- [ ] Write failing tests proving old email remains active, password+fresh factor are required, forced-enrollment cannot mutate email, replacement/cancel invalidates old token, wrong email/epoch/replay fails, duplicate target has one winner, and success revokes sessions.
- [ ] Run RED on users/verification/middleware suites.
- [ ] Request transaction advances email epoch and stores pending email; queue confirmation after commit. Verification atomically claims exact purpose/email/epoch, rechecks uniqueness, swaps/clears state, advances auth/email epochs, and revokes families.
- [ ] Queue old-address notice after commit; never await it in the DB transaction.
- [ ] Run GREEN and commit with `fix(auth): verify recovery email before changing identity`.

### Task 5: Implement email-first partner registration

**Files:**
- Create: `apps/api/src/services/pendingRegistration.ts`
- Create: `apps/api/src/services/pendingRegistration.test.ts`
- Modify: `apps/api/src/routes/auth/register.ts`
- Modify: `apps/api/src/routes/auth/register.test.ts`
- Modify: `apps/api/src/routes/auth/verifyEmail.ts` or create `apps/api/src/routes/auth/verifyRegistration.ts`
- Modify: `apps/api/src/services/partnerCreate.ts` only for verified-consumer input needs

**Interfaces:**
- Produces one-hour SHA-256-keyed pending registration with atomic consume.
- Public registration returns generic 202 and no account/session details.

- [ ] Write failing tests for new/existing byte-identical response, no user lookup, no account/token before verification, Redis/queue failure, TTL/replay/concurrency, uniqueness/policy recheck, terms/hosted expectation, and existing owner sign-in outcome.
- [ ] Run RED.
- [ ] Implement pending storage with at least 256 random bits and opaque email job. Verification `GETDEL`s, rechecks hosted/setup-admin policy and uniqueness, calls `createPartner`, dispatches hooks, then issues the first Wave 1 session.
- [ ] Ensure no partial partner exists on create failure and no consumed record is restored.
- [ ] Run GREEN and commit with `fix(auth): require email verification before partner creation`.

### Task 6: Remove forgot-password and lockout enumeration

**Files:**
- Modify: `apps/api/src/routes/auth/password.ts`
- Modify: `apps/api/src/routes/auth/password.test.ts`
- Modify: `apps/api/src/routes/auth/login.ts`
- Modify: `apps/api/src/routes/auth/login.test.ts`
- Modify: `apps/api/src/services/rate-limit.test.ts`

- [ ] Write failing tests that forgot-password only enqueues opaque work and returns identical 202 without eligibility/email calls; locked/unknown/passwordless/bad-password responses have identical status/body/floor while internal lock audit/notification remains.
- [ ] Run RED.
- [ ] Move eligibility/token/email work to the worker and use generic public response. Change internal account-lock branch to generic 401; keep public IP/input bucket 429 distinct from account lock.
- [ ] Run GREEN and commit with `fix(auth): remove account enumeration from recovery flows`.

### Task 7: Update web flows and localization

**Files:**
- Modify: `apps/web/src/stores/auth.ts` and tests
- Modify: `apps/web/src/components/auth/PartnerRegisterPage.tsx` and tests
- Modify: `apps/web/src/components/auth/VerifyEmailPage.tsx` and tests
- Modify: profile/settings components that edit email and tests
- Modify: `apps/web/src/locales/en/auth.json`, `pt-BR/auth.json`, relevant settings locale files

- [ ] Write failing tests for check-email registration, no auto-login, registration verification outcomes, pending-email display/cancel/replace, fresh step-up, and signed-out completion.
- [ ] Run RED web suites.
- [ ] Update API contracts; pass real `acceptTerms` rather than hard-coded true; scrub verification/reset tokens from URLs/referrers using existing patterns; add localized generic copy.
- [ ] Run GREEN and commit with `feat(auth): expose verified signup and email recovery flows`.

### Task 8: Verify Wave 4

- [ ] Run focused gates:

```bash
corepack pnpm --dir apps/api exec vitest run src/routes/auth/password.test.ts src/routes/auth/register.test.ts src/routes/auth/verifyEmail.test.ts src/routes/users.test.ts src/routes/auth/login.test.ts src/services/passwordResetEligibility.test.ts src/services/emailVerification.test.ts src/services/passwordReset.test.ts src/services/pendingRegistration.test.ts src/jobs/authEmailWorker.test.ts --maxWorkers=1 --fileParallelism=false
corepack pnpm --filter @breeze/api build
corepack pnpm --filter @breeze/web build
corepack pnpm db:check-drift
corepack pnpm --dir apps/api run test:rls-coverage
```

- [ ] Run real-DB concurrency tests for reset, email uniqueness, verification, and registration one-winner behavior.
- [ ] Independently review cross-store failure ordering, queue PII, generic timing/shape, pending-email authority, family revocation, and URL token scrubbing.
- [ ] Update `CHANGELOG.md` with email-first signup, verified email changes, and global session invalidation after recovery; commit with `docs(auth): document identity recovery changes`.
