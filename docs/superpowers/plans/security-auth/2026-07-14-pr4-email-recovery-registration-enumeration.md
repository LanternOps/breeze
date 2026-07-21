# PR 4 — Email, Recovery, Registration, and Enumeration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Scope:** SR2-17, SR2-18, SR2-21, SR2-22, SR2-23 from `docs/superpowers/specs/security-auth/2026-07-11-core-authentication-hardening-design.md`, plus three carry-forward items deliberately deferred out of PR 3 to keep it SSO-scoped.

**Goal:** Make the *verified* email address the only identity Breeze will act on, make account recovery and registration produce **publicly indistinguishable** behaviour for "this account exists" and "it does not", and stop an email change from silently converting a stolen session into a permanent account takeover.

**Architecture:**
- **SR2-17 (pending email):** `PATCH /users/me` stops writing `users.email`. It writes `users.pending_email` + `pending_email_requested_at`, advances `email_epoch` (which kills every outstanding verification artifact bound to the old generation), notifies the OLD address, and mints an `email_verification_tokens` row with a new `purpose='email_change'` column. Only `POST /auth/verify-email` on that token swaps the address — atomically, under the existing `users_email_unique` constraint, advancing `auth_epoch` + `email_epoch` and revoking all refresh families. Until then the old address remains authoritative for login, password reset, CF Access, and SSO matching.
- **SR2-18 (recovery-address step-up):** an email change requires current-password step-up **and** a fresh existing-factor MFA proof on an MFA-protected account; a user parked in the `mfa_enrollment_required` forced-enrollment state may not mutate their email at all (the `/users/me` exemption exists to let them *enroll*, not to let them move their recovery address).
- **SR2-21 (email-first registration):** `POST /auth/register-partner` performs **no user-existence lookup**, creates **no** partner/user/tokens. It hashes the password, stores a pending-registration record in Redis under `SHA-256(token)` with the step-1 abuse attribution (trusted client IP + user agent, per #2343), enqueues an email job, and returns one fixed generic body. `POST /auth/verify-email` on that token atomically consumes the record, re-checks uniqueness + registration policy, calls `createPartner` with the **step-1** attribution, and only then mints the session.
- **SR2-22 (async forgot-password):** `/auth/forgot-password` does zero conditional work — no DB read, no epoch advance, no email send in the request. It enqueues an opaque job and returns the fixed generic body. A new BullMQ worker resolves eligibility, advances `password_reset_epoch`, writes the reset envelope, and sends.
- **SR2-23 (locked-account uniformity):** a locked account returns the byte-identical generic 401 that an unknown email and a wrong password return, floored by the existing `loginResponseFloorPromise()`. Owner notification stays out-of-band (the lockout email already fires).

**Tech Stack:** Hono (TypeScript), Drizzle ORM, PostgreSQL (RLS via `breeze_app`), Redis (ioredis), BullMQ, Vitest, Astro + React (web), i18next (5 locales).

---

## Open Questions / Plan Conflicts — ADJUDICATE BEFORE EXECUTION

These are places where the design doc is ambiguous, self-contradictory, or collides with a project constraint. The plan below picks a default for each (stated), but the overseer should confirm.

**Q1 — Does `CF_ACCESS_TRUSTS_MFA` override forced enrollment?**
The design says (MFA policy section): "an unenrolled user receives a forced-enrollment response and never receives `mfa=true`". But `CF_ACCESS_TRUSTS_MFA` is an explicit operator assertion that the Cloudflare Access edge already performed MFA, and `cfAccessLogin.ts:200` / `cfAccessRedirectLogin.ts:170` currently mint `mfa: trustsMfa || !(ENABLE_2FA && user.mfaEnabled)` — so an unenrolled user under a `required` policy gets `mfa=true` today either way (both via `trustsMfa` and via the `!user.mfaEnabled` term).
**Plan default (fail closed):** the `!user.mfaEnabled` term is removed unconditionally (that is the bug). `trustsMfa` continues to satisfy MFA **only for a user who has a Breeze factor enrolled**; an unenrolled user under a `required` policy gets `mfa=false` + `mfaEnrollmentRequired: true` even when `CF_ACCESS_TRUSTS_MFA=true`. Rationale: the design's invariant is about *Breeze* assurance, and `mfa_epoch` has no meaning for a user with no factor. **If the overseer wants `CF_ACCESS_TRUSTS_MFA` to also satisfy forced enrollment, say so — Task 2 changes one boolean.**

**Q2 — Does *initiating* a pending email change still sign the user out?**
#2428 (shipped) makes `PATCH /users/me` advance `auth_epoch` + `email_epoch` and revoke all refresh families on an email change. The design's pending-email section says initiation "stores a pending email and advances `email_epoch`" and reserves the `auth_epoch` advance + family revocation for *successful verification*. Keeping the shipped behaviour would sign the user out at initiation and leave them unable to reach the verification UI while logged in.
**Plan default:** initiation advances **`email_epoch` only** (no `auth_epoch` bump, no family revoke). Commit advances `auth_epoch` + `email_epoch` and revokes all families. This is a deliberate *narrowing* of shipped #2428 behaviour and Task 7 changes it. The security property is preserved because the address does not move at initiation — nothing about the recovery surface has actually changed yet.

**Q3 — Does the old address get one notification or two?**
Design: "The 'email changed' security notification to the old address fires when the pending change is initiated, **not only** on completion." "Not only" implies both.
**Plan default:** send `sendEmailChanged` to the OLD address at **initiation** (worded as "a change was *requested*") and again at **commit** (worded as "the change *completed*"). Two new email-copy variants are needed; the plan reuses the single existing `sendEmailChanged` template with a new `pending: boolean` param rather than adding a template. Confirm you want both.

**Q4 — SR2-18 "recovery-email mutation" — there is no `recovery_email` column.**
Repo-wide grep finds no `recovery_email` / `recoveryEmail` on `users`. The account's `users.email` **is** the recovery address (it drives `/forgot-password` and MFA recovery).
**Plan default:** SR2-18 is read as "changing `users.email` is a recovery-surface mutation" → requires password + fresh-factor step-up, and is forbidden while in `mfa_enrollment_required`. If the design intended a *separate* recovery-email field, that is a new feature and out of scope — say so.

**Q5 — What does an existing-email signup request actually send?**
Design: existing-email requests "produce the same public response and **equivalent asynchronous work** without creating duplicate tenants", and step 1 "performs no user-existence lookup". Because step 1 cannot know the address is taken, *something* gets mailed to a real account holder every time an attacker types their address into signup.
**Plan default (b):** the worker (not the request) resolves existence and sends **either** the signup-verification email **or** an "someone attempted to sign up with this address — sign in instead / reset your password" notice. The requester cannot observe the difference (same response, same latency, same queue job). Option (a) — mail the signup link regardless and dead-end at step 2 — is the literal reading but hands an existing account holder a link that looks like a new-account link. Confirm (b).

**Q6 — No timing floor is added to `/register-partner` or `/forgot-password`.**
Both handlers become **branch-free** with respect to the submitted email (no DB read, identical Redis + queue work on every input), so there is nothing to equalize. The design says indistinguishability "does not depend on rate limits", which the plan honours. A wall-clock floor is therefore *not* added; the guard is a structural test (Task 5/Task 9: assert the handler never calls `db.select` / `db.transaction`). If the overseer wants belt-and-braces floors like `/login`'s `LOGIN_RESPONSE_FLOOR_MS`, say so and each is ~5 lines.

**Q7 — Collision with PR 3 (#2492).** #2492 touches `apps/api/src/routes/users.ts` (+149 lines: the SSO role-ceiling / `roleAssignment` extraction) and `apps/api/src/routes/sso.ts`. Task 7 rewrites `PATCH /users/me` in the same file but a different handler; Task 8 adds a read-only assertion about `sso.ts`. Expect a trivial rebase, not a conflict. **This plan is written against `main`-with-#2492-merged.** If #2492 has NOT merged when execution starts, stop and re-base the plan.

---

## Global Constraints

- **Node 22.20.0.** Prefix every `pnpm`/`node` command with `export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"` (no version manager is installed; the pinned binary lives there).
- **Migrations are hand-written idempotent SQL only**, in `apps/api/migrations/`, named `YYYY-MM-DD-<slug>.sql`, applied in `localeCompare` order. The latest shipped file is `2026-07-17-sso-default-role-configured-by-on-delete.sql`, so this PR's migration MUST sort after it. `ADD COLUMN IF NOT EXISTS` / `DO $$ … END $$` guards; re-applying must be a no-op. **No inner `BEGIN;`/`COMMIT;`** — the runner wraps each file in a transaction. **Never edit a shipped migration.** Never `drizzle-kit generate`/`push`.
- **RLS / tenant isolation.** The API connects as unprivileged `breeze_app`. Every tenant-scoped table needs RLS enabled + FORCED + policies **in the same migration that creates it**, plus registration in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`. **This PR deliberately introduces NO new Postgres tables**: pending registrations live in Redis (design decision), pending email lives in two new columns on the already-RLS'd `users` table, and the verification-purpose discriminator is a new column on the already-RLS'd `email_verification_tokens` table. Therefore **no `rls-coverage.integration.test.ts` allowlist changes are needed** — if any task finds itself wanting a new table, STOP and escalate.
- **`withSystemDbAccessContext` inside an authenticated request WITHOUT `runOutsideDbContext()` first is a SILENT NO-OP** (`withDbAccessContext` no-ops when a context is already active). And `runOutsideDbContext` does **not** close an outer *transaction* — a slow outbound call (email send, HTTP) inside a held request transaction needs the route registered in `apps/api/src/middleware/selfManagedDbContextRoutes.ts` (`SELF_MANAGED_DB_CONTEXT_ROUTES`). No task here holds a transaction across an email send; if you find yourself doing so, restructure instead.
- **A contextless read of a FORCE-RLS table returns 0 rows.** Any security decision derived from "0 rows ⇒ no constraint / no permissions" is a **FAIL-OPEN**. Every gate in this PR must FAIL CLOSED: a missing user row, a failed epoch read, an unreadable pending record, or a Redis outage denies the operation. Each task states its fail-closed rule explicitly.
- **Enumeration is the point of this PR.** For every endpoint touched, the *response body*, the *HTTP status*, and the *observable latency* must not distinguish "this email has an account" from "it does not". Each task states its uniformity contract precisely and ships a test for it. "Uniform" is defined **per endpoint** below — it is not a vague aspiration:
  - `POST /auth/register-partner` → always `200 {"success":true,"message":"If registration can proceed, you will receive next steps shortly."}` for any syntactically valid body that clears rate limiting and password strength. Handler performs **zero** DB reads.
  - `POST /auth/forgot-password` → always `200 {"success":true,"message":"If this email exists, a reset link will be sent."}`. Handler performs **zero** DB reads and **zero** email sends.
  - `POST /auth/login` → unknown email, wrong password, and **locked account** all return byte-identical `genericAuthError()` at 401, all awaiting the same `floorPromise`.
  - `POST /auth/verify-email` → an invalid / expired / consumed / superseded token returns the same generic 400 regardless of whether the embedded address has an account.
- **i18n: FIVE locales.** `apps/web/src/locales/{en,pt-BR,de-DE,es-419,fr-FR}/`. Every new user-facing string must land in **all five** or the `localeParity` test fails. Tasks 4 and 10 add strings — they say so explicitly.
- **Web mutation handlers use `runAction`** (`apps/web/src/lib/runAction.ts`); the `no-silent-mutations` test (`apps/web/src/lib/__tests__/no-silent-mutations.test.ts`) guards the adopted set and `apps/web/src/lib/runActionAllowlist.ts` records exceptions. If a web task changes the number of mutation handlers, reconcile the allowlist in the same commit (count drift has reddened `main` before).
- **Every security gate needs a guard-bite-able test** — a test that provably goes RED if you delete the protection. A test that would still pass with the guard removed is vacuous and does not count. Each task names its guard-bite test.
- **Test-mock hazard.** `apps/api/src/routes/auth/*.test.ts` and `apps/api/src/routes/sso.test.ts` use hand-rolled Drizzle mocks with **ORDERED `mockReturnValueOnce` queues — one chain per `db.select()`**. Adding or removing a `db.select()` in a handler **desyncs every subsequent chain in that test**. When you remove a select (Tasks 5 and 9 remove several), **re-prime the queue; never delete assertions to make it pass.**
- **Real-DB tasks must stand up their own Postgres.** The shared integration Postgres on `:5433` is routinely contaminated by other worktrees, and `docker-compose.test.yml` has an **unsized tmpfs** that fabricates failures (SQLSTATE 53100, spurious deadlocks). Task 11 stands up a private `postgres:16-alpine` with a sized tmpfs — copy that recipe, don't reuse `:5433`.
- **Audit events never contain raw tokens, passwords, reset/verification tokens, or MFA codes.**
- **Commit after each green task.** TDD: write the failing test, observe the reviewed failure, then implement.

---

## File Structure

**Create**
- `apps/api/migrations/2026-07-18-pending-email-and-verification-purpose.sql` — `users.pending_email`, `users.pending_email_requested_at`, `email_verification_tokens.purpose`.
- `apps/api/src/services/authEmailQueue.ts` — BullMQ enqueue side (`auth-email` queue): `enqueuePasswordResetRequest`, `enqueueRegistrationVerification`.
- `apps/api/src/services/authEmailQueue.test.ts`
- `apps/api/src/jobs/authEmailWorker.ts` — the worker: resolves eligibility, advances epochs, writes artifacts, sends mail.
- `apps/api/src/jobs/authEmailWorker.test.ts`
- `apps/api/src/services/pendingRegistration.ts` — Redis pending-registration record (create / consume, single-winner).
- `apps/api/src/services/pendingRegistration.test.ts`
- `apps/api/src/services/pendingEmail.ts` — pending-email initiation + commit primitives.
- `apps/api/src/services/pendingEmail.test.ts`
- `apps/api/src/components/…` (web) — `apps/web/src/components/auth/PartnerRegisterPage.tsx` gains a "check your email" state (modify, not create).
- `apps/api/src/__tests__/integration/emailRecoveryRegistration.integration.test.ts` — real-DB coverage.

**Modify**
- `apps/api/src/db/schema/users.ts` — `pendingEmail`, `pendingEmailRequestedAt`.
- `apps/api/src/db/schema/emailVerificationTokens.ts` — `purpose`.
- `apps/api/src/services/mfa.ts` + `apps/api/src/services/index.ts` — delete `verifyMFAToken` (carry-forward 2).
- `apps/api/src/middleware/cfAccessLogin.ts`, `apps/api/src/routes/auth/cfAccessRedirectLogin.ts` — `mfa=true` parity (carry-forward 1).
- `apps/api/src/routes/auth/mfa.ts`, `apps/api/src/routes/auth/phone.ts` — step-up grant consume ordering (carry-forward 3).
- `apps/api/src/routes/auth/login.ts` — generic locked-account response (SR2-23).
- `apps/api/src/routes/auth/password.ts` — async `/forgot-password` (SR2-22).
- `apps/api/src/routes/users.ts` — pending-email `PATCH /users/me` (SR2-17/18).
- `apps/api/src/middleware/auth.ts` — forced-enrollment exemption must not permit email mutation (SR2-18).
- `apps/api/src/services/emailVerification.ts` — purpose-aware mint + consume, pending-email commit, pending-registration commit (SR2-17/21).
- `apps/api/src/routes/auth/verifyEmail.ts` — dispatch on purpose (SR2-17/21).
- `apps/api/src/routes/auth/register.ts` — email-first two-step (SR2-21).
- `apps/api/src/services/email.ts` — `sendEmailChanged({ pending })`, `sendSignupAttemptOnExistingAccount`.
- `apps/api/src/index.ts` — register `initializeAuthEmailWorker` / `shutdownAuthEmailWorker`.
- `apps/web/src/components/auth/PartnerRegisterPage.tsx`, `apps/web/src/stores/auth.ts`, `apps/web/src/components/auth/VerifyEmailPage.tsx`, `apps/web/src/components/settings/…` (email-change UI).
- `apps/web/src/locales/{en,pt-BR,de-DE,es-419,fr-FR}/auth.json` and `settings.json`.
- `e2e-tests/live-signup/phases/apiSmoke.ts`, `e2e-tests/live-signup/phases/uiFlow.ts`.

---

### Task 1: Delete the dead `verifyMFAToken` (carry-forward 2)

**Files:**
- Modify: `apps/api/src/services/mfa.ts:10`
- Modify: `apps/api/src/services/index.ts` (the `./mfa` re-export list)
- Modify: `apps/api/src/routes/auth.test.ts:18,248,1461,1496,2416`, `apps/api/src/routes/auth.passkeys.test.ts:63`, `apps/api/src/routes/docs.test.ts:17`

**Interfaces:**
- Removes: `verifyMFAToken(secret: string, token: string): Promise<boolean>` from `services/mfa.ts` and from the `services` barrel. Nothing in production code calls it — every real caller already uses the single-use `consumeMFAToken`. It survives only as a mock entry in three test files and as a footgun any future author could pick up by autocomplete.

- [ ] **Step 1: Prove it is dead**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd /Users/toddhebebrand/orca/workspaces/breeze/core-auth-hardening
grep -rn "verifyMFAToken" apps/api/src agent apps/web packages e2e-tests
```
Expected output: exactly seven hits — `apps/api/src/services/mfa.ts:10` (the definition), `apps/api/src/routes/auth/helpers.ts:196` (a *comment* naming it, not a call), `apps/api/src/routes/auth.test.ts` ×4, `apps/api/src/routes/auth.passkeys.test.ts:63`, `apps/api/src/routes/docs.test.ts:17`. **Zero production call sites.** If you find a production call site, STOP — the item is not a dead-code deletion and needs escalation.

- [ ] **Step 2: Write the failing test**

Add to `apps/api/src/services/mfa.test.ts` (the file exists):

```ts
describe('dead-code guard', () => {
  it('does not export a non-consuming verifyMFAToken', async () => {
    const mod = (await import('./mfa')) as Record<string, unknown>;
    // A non-consuming TOTP verifier lets a sniffed live code be replayed
    // across multiple critical actions inside its ~90s window. consumeMFAToken
    // is the only permitted verifier (SR2-24). Keep this guard: re-adding a
    // plain verifier must fail CI, not just review.
    expect(mod.verifyMFAToken).toBeUndefined();
  });
});
```

This is the guard-bite test: restore the export and it goes RED.

- [ ] **Step 3: Run to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/mfa.test.ts -t 'dead-code'
```
Expected: FAIL — `verifyMFAToken` is still exported.

- [ ] **Step 4: Implement**

In `apps/api/src/services/mfa.ts`, delete the whole function starting at line 10:

```ts
export async function verifyMFAToken(secret: string, token: string): Promise<boolean> {
  // …delete the entire body…
}
```

In `apps/api/src/services/index.ts`, remove `verifyMFAToken` from the `export { … } from './mfa';` list (leave `consumeMFAToken`, `generateMFASecret`, `generateOTPAuthURL`, `generateQRCode`, `generateRecoveryCodes` in place).

In `apps/api/src/routes/auth.test.ts`: remove `verifyMFAToken: vi.fn(),` from the `vi.mock('../services', …)` factory (line 18), remove `verifyMFAToken` from the import list (line 248), and **replace** the two `expect(verifyMFAToken).not.toHaveBeenCalled();` assertions (lines 1496 and 2416) with the equivalent positive assertion already available in each block — `expect(consumeMFAToken).toHaveBeenCalledWith(expect.any(String), '123456', expect.any(String));` (read the surrounding block for the exact code/user values; do **not** simply delete the assertions — the point of both tests is that the *consuming* verifier is the one that ran). Rename the test title at line 1461 from `'confirms setup via consumeMFAToken, not the plain (non-consuming) verifyMFAToken'` to `'confirms setup via the consuming consumeMFAToken verifier'`.

In `apps/api/src/routes/auth.passkeys.test.ts:63` and `apps/api/src/routes/docs.test.ts:17`: delete the `verifyMFAToken: vi.fn(),` line from each `vi.mock` factory.

- [ ] **Step 5: Run to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/mfa.test.ts src/routes/auth.test.ts src/routes/auth.passkeys.test.ts src/routes/docs.test.ts && pnpm typecheck
```
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/mfa.ts apps/api/src/services/mfa.test.ts apps/api/src/services/index.ts apps/api/src/routes/auth.test.ts apps/api/src/routes/auth.passkeys.test.ts apps/api/src/routes/docs.test.ts
git commit -m "refactor(auth): delete the dead non-consuming verifyMFAToken (PR3 carry-forward)"
```

---

### Task 2: CF Access `mfa=true` parity with the password login path (carry-forward 1)

**Files:**
- Modify: `apps/api/src/middleware/cfAccessLogin.ts:200`
- Modify: `apps/api/src/routes/auth/cfAccessRedirectLogin.ts:170`
- Test: `apps/api/src/middleware/cfAccessLogin.test.ts`, `apps/api/src/routes/auth/cfAccessRedirectLogin.test.ts`

**Interfaces:**
- Consumes: `getEffectiveMfaPolicy` from `../services/mfaPolicy` (already imported in `cfAccessLogin.ts:26`; **add the import** to `cfAccessRedirectLogin.ts`).
- Produces: both CF Access mint sites resolve the effective MFA policy and mint `mfa: false` + return `mfaEnrollmentRequired: true` for an **unenrolled** user under a `required` policy — exactly what `routes/auth/login.ts:517-519` does.

**The bug.** Both files currently compute:
```ts
const mfaSatisfied = trustsMfa || !(ENABLE_2FA && user.mfaEnabled);
```
The `!(ENABLE_2FA && user.mfaEnabled)` term hands `mfa: true` to any user with no MFA factor — **including one whose effective policy requires MFA**. The password `/login` handler resolves the policy and mints `mfa: false` for exactly that user (`login.ts:519`). A CF Access login therefore bypasses forced enrollment and every `hasSatisfiedMfa`-gated action. See **Q1** for the `trustsMfa` half of the expression, which this task preserves for *enrolled* users only.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/middleware/cfAccessLogin.test.ts`, extend the existing `vi.mock('../services/mfaPolicy', …)` factory if present (grep for it; if absent add `vi.mock('../services/mfaPolicy', () => ({ getEffectiveMfaPolicy: vi.fn(async () => ({ required: false, allowedMethods: { totp: true, sms: true, passkey: true } })) }));` at the top with the other mocks). Then add:

```ts
describe('cfAccessLogin — MFA assurance parity with /login (PR3 carry-forward)', () => {
  it('an unenrolled user under a required policy is NOT granted mfa=true', async () => {
    vi.mocked(getEffectiveMfaPolicy).mockResolvedValue({
      required: true,
      allowedMethods: { totp: true, sms: true, passkey: true },
    });
    // user row: mfaEnabled: false  (copy the file's existing happy-path user fixture
    // and flip mfaEnabled to false)
    const res = await callCfAccessLogin();      // ← the file's existing driver helper
    expect(res.status).toBe(200);
    expect(vi.mocked(createTokenPair)).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: false }),
      expect.anything()
    );
    const body = await res.json();
    expect(body.mfaEnrollmentRequired).toBe(true);
  });

  it('an unenrolled user under a NON-required policy still gets mfa=true', async () => {
    vi.mocked(getEffectiveMfaPolicy).mockResolvedValue({
      required: false,
      allowedMethods: { totp: true, sms: true, passkey: true },
    });
    await callCfAccessLogin();
    expect(vi.mocked(createTokenPair)).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: true }),
      expect.anything()
    );
  });

  it('CF_ACCESS_TRUSTS_MFA does NOT satisfy a required policy for an unenrolled user (Q1: fail closed)', async () => {
    process.env.CF_ACCESS_TRUSTS_MFA = 'true';
    vi.mocked(getEffectiveMfaPolicy).mockResolvedValue({
      required: true,
      allowedMethods: { totp: true, sms: true, passkey: true },
    });
    await callCfAccessLogin();       // unenrolled user fixture
    expect(vi.mocked(createTokenPair)).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: false }),
      expect.anything()
    );
  });
});
```

Read the file first for the real driver-helper name and the user fixture — the suite already drives the middleware end-to-end for the happy path; **reuse that harness**, don't invent one. Mirror all three cases into `cfAccessRedirectLogin.test.ts` against that file's own harness.

Guard-bite: restore `|| !(ENABLE_2FA && user.mfaEnabled)` and case 1 + case 3 go RED.

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/middleware/cfAccessLogin.test.ts src/routes/auth/cfAccessRedirectLogin.test.ts -t 'parity'
```
Expected: FAIL — `createTokenPair` was called with `mfa: true` for the unenrolled user.

- [ ] **Step 3: Implement**

In `apps/api/src/middleware/cfAccessLogin.ts`, replace line 200:

```ts
  const mfaSatisfied = trustsMfa || !(ENABLE_2FA && user.mfaEnabled);
```

with:

```ts
  // Parity with the password /login handler (routes/auth/login.ts:517-519).
  // Reaching here means the user is NOT MFA-challenged: either they have no
  // Breeze factor, or CF_ACCESS_TRUSTS_MFA asserts the edge already did MFA.
  //
  // The old `|| !(ENABLE_2FA && user.mfaEnabled)` term granted vacuous
  // assurance to any user with no factor — INCLUDING one whose effective
  // policy requires MFA — so a CF Access login walked straight past forced
  // enrollment and every hasSatisfiedMfa() gate. An unenrolled user under a
  // required policy must get mfa=false and a forced-enrollment response,
  // exactly as the password path does. `trustsMfa` still satisfies MFA, but
  // ONLY for a user who actually HAS a factor: the operator is asserting the
  // edge performed a second factor, not that policy is irrelevant (Q1).
  const policy = await getEffectiveMfaPolicy({
    scope: context.scope,
    userId: user.id,
    orgId: context.orgId,
    partnerId: context.partnerId,
  });
  const mfaEnrollmentRequired = ENABLE_2FA && !user.mfaEnabled && policy.required;
  const mfaSatisfied =
    !ENABLE_2FA ||
    (user.mfaEnabled && trustsMfa) ||
    (!user.mfaEnabled && !policy.required);
```

and add `mfaEnrollmentRequired,` to the JSON body returned at `cfAccessLogin.ts:257-268` (alongside `mfaRequired: false` and `requiresSetup`).

Apply the identical change at `apps/api/src/routes/auth/cfAccessRedirectLogin.ts:170` (both `mfa: mfaSatisfied` uses at `:188` and `:214` then pick it up automatically). That file resolves its token context into a variable — read it and use the real variable name; add `import { getEffectiveMfaPolicy } from '../../services/mfaPolicy';`. If `cfAccessRedirectLogin` responds with a redirect rather than JSON, do **not** invent a body field — the `mfa: false` claim alone drives the 428 forced-enrollment gate in `authMiddleware`, which is the security-relevant half; note that in a comment.

- [ ] **Step 4: Run to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/middleware/cfAccessLogin.test.ts src/routes/auth/cfAccessRedirectLogin.test.ts src/routes/auth/login.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/cfAccessLogin.ts apps/api/src/middleware/cfAccessLogin.test.ts apps/api/src/routes/auth/cfAccessRedirectLogin.ts apps/api/src/routes/auth/cfAccessRedirectLogin.test.ts
git commit -m "fix(auth): CF Access mint sites honour effective MFA policy; no vacuous mfa=true for unenrolled users (PR3 carry-forward)"
```

---

### Task 3: Step-up grant is consumed AFTER the factor proof validates (carry-forward 3)

**Files:**
- Modify: `apps/api/src/routes/auth/mfa.ts:403` (setup-confirm, Case 2), `apps/api/src/routes/auth/mfa.ts:607` (`/mfa/enable`)
- Modify: `apps/api/src/routes/auth/phone.ts:117` (`/phone/confirm`), `apps/api/src/routes/auth/phone.ts:224` (`/mfa/sms/enable`)
- Test: `apps/api/src/routes/auth.test.ts` (the `/mfa/enable` + setup-confirm blocks), `apps/api/src/routes/auth/phone.test.ts:249,372,397`

**Interfaces:**
- Consumes: the existing `enforceExistingFactorStepUp(c, auth, grantId, { consume: boolean })` from `routes/auth/helpers.ts:252`. **No signature change** — the two-phase idiom already exists and is used correctly by `passkeys.ts:127` (`consume: false` at `register/options`) + `passkeys.ts:178` (`consume: true` at `register/verify`, **after** the WebAuthn assertion verifies).
- Produces: on `/mfa/enable`, setup-confirm, and `/phone/confirm`, the grant is **validated** (non-consuming) before the code check and **consumed** only after the code proves valid. A wrong TOTP/SMS code no longer burns the user's single-use grant. On `/mfa/sms/enable` the consume moves after the phone-verified / not-already-enabled precondition checks so a benign 400 does not burn it either.

**The bug.** `mfa.ts:607` calls `enforceExistingFactorStepUp(…, { consume: true })` and only then, at `:640`, calls `consumeMFAToken(secret, code, auth.user.id)`. A user who fat-fingers the 6-digit code gets a 401 **and** has already lost the grant — they must re-run the whole `/auth/mfa/step-up` dance. Same at `mfa.ts:403`/`:409` and `phone.ts:117` (SMS code checked further down). The comment at `mfa.ts:401-402` explains the current ordering was chosen so a *bad grant* 403s without burning the TOTP time-step — the two-phase split preserves **both** properties.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/routes/auth.test.ts`, inside the existing `/mfa/enable` describe block (grep for `'/mfa/enable'`), add — reusing that block's existing mock setup for an **already-MFA-protected** user (`userIsMfaProtected` → true) with a valid grant:

```ts
it('a WRONG mfa code does not burn the step-up grant (grant survives for a retry)', async () => {
  vi.mocked(consumeMFAToken).mockResolvedValueOnce(false);   // wrong code
  const bad = await postMfaEnable({ code: '000000', currentPassword: 'pw', stepUpGrantId: 'grant-1' });
  expect(bad.status).toBe(401);
  // The grant must NOT have been consumed by the failed attempt.
  expect(vi.mocked(consumeStepUpGrant)).not.toHaveBeenCalled();
  expect(vi.mocked(validateStepUpGrant)).toHaveBeenCalled();

  // The SAME grant now works with the correct code.
  vi.mocked(consumeMFAToken).mockResolvedValueOnce(true);
  const good = await postMfaEnable({ code: '123456', currentPassword: 'pw', stepUpGrantId: 'grant-1' });
  expect(good.status).toBe(200);
  expect(vi.mocked(consumeStepUpGrant)).toHaveBeenCalledTimes(1);
});

it('an INVALID grant still 403s BEFORE the consuming TOTP verifier runs (no burned time-step)', async () => {
  vi.mocked(validateStepUpGrant).mockResolvedValueOnce(false);
  const res = await postMfaEnable({ code: '123456', currentPassword: 'pw', stepUpGrantId: 'bogus' });
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ error: 'existing_factor_step_up_required' });
  expect(vi.mocked(consumeMFAToken)).not.toHaveBeenCalled();
});
```

`validateStepUpGrant` / `consumeStepUpGrant` come from `services/mfaStepUpGrant` — add that module to the file's `vi.mock` set if it isn't already mocked (grep first; `enforceExistingFactorStepUp` in `helpers.ts` calls them). Use the file's real driver helper name for `postMfaEnable`. Mirror both cases into the setup-confirm block and (with `checkVerificationCode` in place of `consumeMFAToken`) into `phone.test.ts` for `/phone/confirm`.

Guard-bite: revert to a single `{ consume: true }` before the code check and test 1 goes RED (the grant is consumed on the wrong-code attempt); revert to a single `{ consume: true }` *after* the code check and test 2 goes RED (`consumeMFAToken` ran despite the bad grant). **Both tests are required — either one alone is satisfiable by a wrong implementation.**

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth.test.ts -t 'burn' && cd . 
```
Expected: FAIL — `consumeStepUpGrant` was called on the wrong-code attempt.

- [ ] **Step 3: Implement**

`apps/api/src/routes/auth/mfa.ts:605-608` (`/mfa/enable`) — replace:

```ts
  // SR2-20: adding a factor to an ALREADY-PROTECTED account additionally
  // requires a fresh existing-factor proof (no-op for initial enrollment).
  const stepUpError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, { consume: true });
  if (stepUpError) return stepUpError;
```

with:

```ts
  // SR2-20: adding a factor to an ALREADY-PROTECTED account additionally
  // requires a fresh existing-factor proof (no-op for initial enrollment).
  //
  // Two-phase, same idiom as passkeys register/options + register/verify:
  //   validate (non-consuming) HERE, so a missing/bogus/stale grant 403s
  //   before the consuming TOTP verifier burns the setup time-step;
  //   consume BELOW, only once the code itself has proven valid, so a
  //   fat-fingered 6-digit code does not destroy the user's single-use grant
  //   and force them back through /auth/mfa/step-up. (PR3 carry-forward.)
  const stepUpError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, { consume: false });
  if (stepUpError) return stepUpError;
```

Then, immediately after the `if (!valid) { … return c.json({ error: message, message }, 401); }` block that ends at `:654` — i.e. on the path where the code IS valid, and **before** the `invalidateMfaAssuranceAfterFactorChange` call at `:656` — insert:

```ts
  // Terminal factor write: NOW consume the grant (single-use). Re-checks the
  // binding against the LIVE epochs, so a factor change or session switch
  // between validate and consume invalidates it. A loss here (concurrent
  // consume of the same grant) fails CLOSED with the same 403 — the factor is
  // not written.
  const stepUpConsumeError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, { consume: true });
  if (stepUpConsumeError) return stepUpConsumeError;
```

Apply the identical split at `mfa.ts:403` (validate) → after the `if (!valid)` block ending at `:423` (consume), keeping the existing comment's intent (update its wording to describe the two-phase split).

`apps/api/src/routes/auth/phone.ts:117` (`/phone/confirm`): change to `{ consume: false }` with the same comment, and add the `{ consume: true }` consume immediately after the Twilio `checkVerificationCode` result proves valid (read the file for the exact variable — the success branch is the one that flips `phoneVerified`).

`apps/api/src/routes/auth/phone.ts:224` (`/mfa/sms/enable`): change to `{ consume: false }` and move the `{ consume: true }` consume to just **after** the two precondition guards (`!user.phoneVerified || !user.phoneNumber` → 400, and `user.mfaEnabled` → 400) and before the factor write. No code is validated on this route, so the split only prevents a benign 400 from burning the grant.

- [ ] **Step 4: Run to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth.test.ts src/routes/auth/phone.test.ts src/routes/auth.passkeys.test.ts src/routes/auth/helpers.mfaStepUp.test.ts
```
Expected: PASS. `phone.test.ts:249,372,397` currently assert `{ consume: true }` was passed — update each to the new expectation (`{ consume: false }` at the gate, `{ consume: true }` at the terminal write). **Re-prime, don't delete.**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/mfa.ts apps/api/src/routes/auth/phone.ts apps/api/src/routes/auth.test.ts apps/api/src/routes/auth/phone.test.ts
git commit -m "fix(auth): consume the MFA step-up grant only after the factor proof validates (PR3 carry-forward)"
```

---

### Task 4: SR2-23 — a locked account returns the generic login denial

**Files:**
- Modify: `apps/api/src/routes/auth/login.ts:308-325`
- Test: `apps/api/src/routes/auth/login.test.ts`
- Modify (i18n, if the web surfaced the lockout copy): `apps/web/src/locales/{en,pt-BR,de-DE,es-419,fr-FR}/auth.json`

**Interfaces:**
- Consumes: `genericAuthError()` (already imported in `login.ts:49`), `isAccountLocked`, `getAccountLockoutWindowSeconds`, the existing `floorPromise`.
- Produces: the locked-account branch returns **`c.json(genericAuthError(), 401)`** — byte-identical to the unknown-email branch (`:296`) and the wrong-password branch — after awaiting `floorPromise`. The `retryAfter` field and the "Account temporarily locked…" string are **deleted from the response**. The audit event (`reason: 'account_locked'`, `result: 'denied'`) and the out-of-band lockout email (`recordAccountFailureAndMaybeNotify` → `sendAccountLocked`) are unchanged: the owner is still told, through their mailbox, which is the only channel that already proves address ownership.

**Why this is an oracle today.** `login.ts:320-323` returns `429 { error: 'Account temporarily locked due to repeated failed sign-ins…', retryAfter: 900 }`. An attacker who submits five junk passwords for `victim@corp.com` and then sees that body has learned **the account exists** — no valid password required. Unknown emails never lock (the code deliberately does not bump the counter on the miss branch, `:282-284`), so the 429 is a pure existence signal.

**Uniformity contract (explicit).** After this task, for any submitted email, `POST /auth/login` returns exactly one of:
- `401 genericAuthError()` — unknown email, no password hash, wrong password, **locked account**, or a null epoch read;
- `429` — **rate limiting only** (per-IP or per-(client,email) bucket), which is keyed on the *client*, not on account existence;
- `200` with tokens / an MFA challenge — correct credentials on an unlocked account.
Every one of those paths awaits the same `floorPromise`. There is no response that is reachable only when the account exists.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/routes/auth/login.test.ts` — the file already mocks `isAccountLocked` (grep for it) and has a `postLogin` helper:

```ts
describe('POST /login — SR2-23: a locked account is publicly indistinguishable from an unknown one', () => {
  it('returns the same status AND the same body as an unknown email', async () => {
    // Unknown email: no user row.
    selectChain.limit.mockResolvedValueOnce([]);
    const unknown = await postLogin({ email: 'nobody@nowhere.test', password: 'whatever' });
    const unknownBody = await unknown.json();

    // Known email, account locked.
    selectChain.limit.mockResolvedValueOnce([userRow]);   // the file's happy-path user fixture
    vi.mocked(isAccountLocked).mockResolvedValueOnce(true);
    const locked = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });
    const lockedBody = await locked.json();

    expect(locked.status).toBe(unknown.status);
    expect(locked.status).toBe(401);
    expect(lockedBody).toEqual(unknownBody);
    // The old oracle fields must be gone.
    expect(JSON.stringify(lockedBody)).not.toMatch(/lock/i);
    expect(lockedBody).not.toHaveProperty('retryAfter');
  });

  it('still audits the lockout server-side (the signal moves, it does not disappear)', async () => {
    selectChain.limit.mockResolvedValueOnce([userRow]);
    vi.mocked(isAccountLocked).mockResolvedValueOnce(true);
    await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });
    expect(vi.mocked(auditUserLoginFailure)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'account_locked', result: 'denied' })
    );
  });

  it('a locked account does NOT mint tokens even with the correct password', async () => {
    selectChain.limit.mockResolvedValueOnce([userRow]);
    vi.mocked(isAccountLocked).mockResolvedValueOnce(true);
    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });
    expect(res.status).toBe(401);
    expect(vi.mocked(createTokenPair)).not.toHaveBeenCalled();
  });
});
```

Read the file for the real fixture names (`selectChain`, `userRow`, `postLogin`) before writing — **do not invent them**. Guard-bite: restore the `429 { error: 'Account temporarily locked…' }` return and test 1 goes RED on both the status and the body comparison.

- [ ] **Step 2: Run to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth/login.test.ts -t 'SR2-23'
```
Expected: FAIL — locked returns 429 with a lockout message, unknown returns 401 generic.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/auth/login.ts`, replace the body of the lockout branch (`:310-324`):

```ts
    if (await isAccountLocked(redisForLock, normalizedEmail)) {
      void auditUserLoginFailure(c, {
        userId: user.id,
        email: user.email,
        name: user.name,
        reason: 'account_locked',
        result: 'denied',
        details: { method: 'password' }
      });
      // SR2-23: the public response is the SAME generic 401 an unknown email or
      // a wrong password gets — floored on the same clock. The previous
      // `429 { error: 'Account temporarily locked…', retryAfter }` was a pure
      // account-existence oracle: unknown emails never lock (we deliberately do
      // not bump their failure counter, see the miss branch above), so seeing
      // that body proved the address had an account without ever guessing the
      // password. The owner is still told — out of band, in the lockout email
      // that recordAccountFailureAndMaybeNotify already sends to the address
      // itself, which is the only channel that proves ownership. The lockout
      // still BLOCKS the login: a correct password on a locked account must not
      // mint tokens (that is the whole point of the control) — we simply stop
      // announcing it.
      await floorPromise;
      return c.json(genericAuthError(), 401);
    }
```

Also update the comment block at `:299-307` — the clause "Important: returning 429 even when the password is correct is the whole point" is now stale; replace with "Important: DENYING the login even when the password is correct is the whole point — the response shape is the generic 401 (SR2-23), but the denial stands."

- [ ] **Step 4: Sweep the clients**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd /Users/toddhebebrand/orca/workspaces/breeze/core-auth-hardening
grep -rn "temporarily locked\|retryAfter" apps/web/src apps/mobile 2>/dev/null e2e-tests | grep -vi "rate\|429\|resend"
```
Expected: **no hits** referencing the login lockout copy (the web login form renders whatever `error` string the API returns; a grep confirms no client branches on the lockout text). **If there ARE hits**, the client is switching on the lockout message — remove that branch and, if it rendered a translated string, delete the key from **all five** `apps/web/src/locales/*/auth.json` files (the `localeParity` test fails if you drop it from only one). If there are no hits, **no i18n change is needed** and this step is a no-op — record that in the commit body.

- [ ] **Step 5: Run to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth/login.test.ts src/routes/auth.test.ts
cd ../web && pnpm vitest run src/components/auth
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/login.test.ts
git commit -m "fix(auth): a locked account returns the generic login denial, not an existence oracle (SR2-23)"
```

---

### Task 5: SR2-22 — asynchronous, work-free `/forgot-password`

**Files:**
- Create: `apps/api/src/services/authEmailQueue.ts`, `apps/api/src/services/authEmailQueue.test.ts`
- Create: `apps/api/src/jobs/authEmailWorker.ts`, `apps/api/src/jobs/authEmailWorker.test.ts`
- Modify: `apps/api/src/routes/auth/password.ts:79-182` (`/forgot-password`)
- Modify: `apps/api/src/index.ts` (worker init/shutdown registration)
- Test: `apps/api/src/routes/auth/password.test.ts`

**Interfaces:**
- Produces `apps/api/src/services/authEmailQueue.ts`:
  - `export const AUTH_EMAIL_QUEUE = 'auth-email';`
  - `export type AuthEmailJob = { kind: 'password-reset'; email: string } | { kind: 'registration'; tokenHash: string };` (the `registration` variant is added by Task 9 — declare it now so the worker's switch is exhaustive from the start and Task 9 adds only the case body.)
  - `export function getAuthEmailQueue(): Queue<AuthEmailJob>` — built with `createInstrumentedQueue(AUTH_EMAIL_QUEUE)` from `services/bullmqQueue.ts` (the #1105 held-context tripwire; a bare `new Queue` is not acceptable for a new queue).
  - `export async function enqueuePasswordResetRequest(email: string): Promise<void>`
  - `export async function enqueueRegistrationVerification(tokenHash: string): Promise<void>` (Task 9 uses it; ship the function now, it is three lines).
  - **Job ids must not contain `:`** (BullMQ treats a colon as a key separator and silently mangles the id) — do **not** set a `jobId` at all here; a reset request is intentionally not deduped (each request must be able to supersede the last).
- Produces `apps/api/src/jobs/authEmailWorker.ts`: `initializeAuthEmailWorker(): void`, `shutdownAuthEmailWorker(): Promise<void>` — matching every other `jobs/*.ts` module's shape.
- Consumes: `getPasswordResetEligibility` (`services/passwordResetEligibility.ts:74`), `advanceUserEpochs` (`services/authLifecycle.ts`), `getEmailService`, `getRedis`, `recordFailedLogin`.

**Uniformity contract (explicit).** After this task `POST /auth/forgot-password` executes, for **every** syntactically valid body:
1. `getRedis()` (503 if down — that is a service state, not an account state);
2. one `rateLimiter` call keyed on the **client**, not the email (`forgot:${rateLimitClient}`);
3. `enqueuePasswordResetRequest(normalizedEmail)`;
4. `return c.json({ success: true, message: 'If this email exists, a reset link will be sent.' })`.
It performs **zero** DB reads, **zero** DB transactions, **zero** epoch advances, and **zero** email sends. There is no `if` on the email. That is what makes it constant-time: the observable latency is `Redis RTT + queue enqueue`, identical for `ceo@example.com` and `asdf@asdf.invalid`. The rate-limit-exceeded branch already returns the same 200 success body (`password.ts:97-100`) — keep it.

Everything the old handler did conditionally moves into the worker, where the requester cannot observe it: eligibility resolution, the `password_reset_epoch` advance, the `reset:<hash>` envelope write, the email send, the `user.password.reset.requested` audit, and the `recordFailedLogin('reset_tenant_inactive')` anomaly metric.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/authEmailQueue.test.ts` (new):

```ts
import { describe, it, expect, vi } from 'vitest';

const added: unknown[] = [];
vi.mock('./bullmqQueue', () => ({
  createInstrumentedQueue: () => ({
    add: (name: string, data: unknown) => { added.push({ name, data }); return Promise.resolve(); },
  }),
}));

import { enqueuePasswordResetRequest, AUTH_EMAIL_QUEUE } from './authEmailQueue';

describe('authEmailQueue', () => {
  it('enqueues an opaque password-reset job carrying only the submitted address', async () => {
    await enqueuePasswordResetRequest('victim@corp.com');
    expect(AUTH_EMAIL_QUEUE).toBe('auth-email');
    expect(added).toEqual([
      { name: 'password-reset', data: { kind: 'password-reset', email: 'victim@corp.com' } },
    ]);
  });
});
```

`apps/api/src/routes/auth/password.test.ts` — add (the file already mocks `../../db`, `../../services`, `getEmailService` and the reset-eligibility helpers; **add** `vi.mock('../../services/authEmailQueue', () => ({ enqueuePasswordResetRequest: vi.fn(async () => undefined) }));`):

```ts
describe('POST /forgot-password — SR2-22: the request does no conditional work', () => {
  it('returns the identical body for a known and an unknown address', async () => {
    const known = await postForgot({ email: 'admin@msp.com' });
    const unknown = await postForgot({ email: 'nobody@nowhere.test' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
    expect(await known.json()).toEqual({
      success: true,
      message: 'If this email exists, a reset link will be sent.',
    });
  });

  it('does NOT touch the database, does NOT advance an epoch, and does NOT send mail', async () => {
    await postForgot({ email: 'admin@msp.com' });
    // The oracle was the latency of these three. They must not run in-request.
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
    expect(vi.mocked(getPasswordResetEligibility)).not.toHaveBeenCalled();
    expect(vi.mocked(advanceUserEpochs)).not.toHaveBeenCalled();
    expect(sendPasswordReset).not.toHaveBeenCalled();
  });

  it('enqueues exactly one opaque job with the normalized address', async () => {
    await postForgot({ email: '  ADMIN@MSP.com ' });
    expect(vi.mocked(enqueuePasswordResetRequest)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueuePasswordResetRequest)).toHaveBeenCalledWith('admin@msp.com');
  });
});
```

**This is the guard-bite test**: restore any of the in-request DB/eligibility/send calls and test 2 goes RED. Test 1 alone would pass with the old handler (it already returned a generic body) — it is necessary but **not sufficient**, which is exactly why test 2 exists.

`apps/api/src/jobs/authEmailWorker.test.ts` (new) — unit-test the exported job handler directly (export it as `handleAuthEmailJob(job: AuthEmailJob)` so the test does not need a live BullMQ):

```ts
describe('handleAuthEmailJob — password-reset', () => {
  it('an ELIGIBLE user: advances password_reset_epoch, writes the envelope, sends the mail', async () => {
    vi.mocked(getPasswordResetEligibility).mockResolvedValue({
      allowed: true, userId: 'u1', email: 'admin@msp.com',
    });
    vi.mocked(advanceUserEpochs).mockResolvedValue({
      authEpoch: 1, mfaEpoch: 1, emailEpoch: 1, passwordResetEpoch: 7,
    });
    await handleAuthEmailJob({ kind: 'password-reset', email: 'admin@msp.com' });
    const [key, ttl, value] = vi.mocked(redis.setex).mock.calls[0];
    expect(key).toMatch(/^reset:[0-9a-f]{64}$/);
    expect(ttl).toBe(3600);
    expect(JSON.parse(value as string)).toEqual({
      userId: 'u1', passwordResetEpoch: 7, email: 'admin@msp.com',
    });
    expect(sendPasswordReset).toHaveBeenCalledTimes(1);
  });

  it('an UNKNOWN address: no epoch advance, no envelope, no mail — and no throw', async () => {
    vi.mocked(getPasswordResetEligibility).mockResolvedValue({ allowed: false, reason: 'unknown_user' });
    await expect(handleAuthEmailJob({ kind: 'password-reset', email: 'nobody@nowhere.test' })).resolves.toBeUndefined();
    expect(vi.mocked(advanceUserEpochs)).not.toHaveBeenCalled();
    expect(redis.setex).not.toHaveBeenCalled();
    expect(sendPasswordReset).not.toHaveBeenCalled();
  });

  it('an INELIGIBLE known user (tenant_inactive): denial audit + anomaly metric, no mail', async () => {
    vi.mocked(getPasswordResetEligibility).mockResolvedValue({
      allowed: false, reason: 'tenant_inactive', detail: 'partner:suspended', userId: 'u1', email: 'admin@msp.com',
    });
    await handleAuthEmailJob({ kind: 'password-reset', email: 'admin@msp.com' });
    expect(sendPasswordReset).not.toHaveBeenCalled();
    expect(vi.mocked(recordFailedLogin)).toHaveBeenCalledWith('reset_tenant_inactive');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/authEmailQueue.test.ts src/jobs/authEmailWorker.test.ts src/routes/auth/password.test.ts -t 'SR2-22'
```
Expected: FAIL — the two new modules do not exist; `/forgot-password` calls `getPasswordResetEligibility` in-request.

- [ ] **Step 3: Implement the queue**

Create `apps/api/src/services/authEmailQueue.ts`:

```ts
import type { Queue } from 'bullmq';
import { createInstrumentedQueue } from './bullmqQueue';

/**
 * SR2-22 / SR2-21: the enumeration-safe seam for authentication email.
 *
 * `/auth/forgot-password` and `/auth/register-partner` must do NO conditional
 * work in the request — no user-existence lookup, no epoch advance, no email
 * send — or their wall-clock latency tells an attacker whether the submitted
 * address has an account. Both endpoints therefore enqueue one opaque job and
 * return a fixed generic body. All the conditional work happens HERE, in a
 * worker the requester cannot observe.
 *
 * The queue is built through createInstrumentedQueue so the #1105 held-DB-
 * context tripwire fires if a future caller enqueues from inside a held
 * transaction.
 */
export const AUTH_EMAIL_QUEUE = 'auth-email';

export type AuthEmailJob =
  | { kind: 'password-reset'; email: string }
  // Populated by SR2-21 (email-first registration). The job carries only the
  // SHA-256 hash of the pending-registration token — never the raw token, never
  // the password hash, never the email; the worker reads the Redis record.
  | { kind: 'registration'; tokenHash: string };

let queue: Queue<AuthEmailJob> | null = null;

export function getAuthEmailQueue(): Queue<AuthEmailJob> {
  if (!queue) {
    queue = createInstrumentedQueue<AuthEmailJob>(AUTH_EMAIL_QUEUE, {
      defaultJobOptions: {
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
      },
    });
  }
  return queue;
}

/**
 * Deliberately NOT deduped by jobId: each request must be able to supersede the
 * previous generation (advancing password_reset_epoch invalidates the older
 * token). Also: a jobId derived from the email would be a Redis key an attacker
 * with Redis read access could probe for existence — and BullMQ job ids must
 * not contain `:` anyway.
 */
export async function enqueuePasswordResetRequest(email: string): Promise<void> {
  await getAuthEmailQueue().add('password-reset', { kind: 'password-reset', email });
}

export async function enqueueRegistrationVerification(tokenHash: string): Promise<void> {
  await getAuthEmailQueue().add('registration', { kind: 'registration', tokenHash });
}
```

- [ ] **Step 4: Implement the worker**

Create `apps/api/src/jobs/authEmailWorker.ts`. Copy the `initialize…`/`shutdown…` skeleton from an existing single-queue worker (read `apps/api/src/jobs/oauthCleanup.ts` for the exact `new Worker(…, { connection: getBullMQConnection() })` + error-listener + `worker.close()` shape used in this repo). The handler:

```ts
import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import * as dbModule from '../db';
import { getRedis } from '../services/redis';
import { getEmailService } from '../services/email';
import { getPasswordResetEligibility } from '../services/passwordResetEligibility';
import { advanceUserEpochs } from '../services/authLifecycle';
import { recordFailedLogin } from '../services/anomalyMetrics';
import { createAuditLog, ANONYMOUS_ACTOR_ID } from '../services/auditService';
import { captureException } from '../services/sentry';
import type { AuthEmailJob } from '../services/authEmailQueue';

const { db, withSystemDbAccessContext } = dbModule;

/**
 * Exported for unit test — the Worker below is a thin wrapper. Never throws for
 * an "account does not exist" outcome: that is a normal, expected result, not a
 * job failure (a retry storm on unknown addresses would be its own side channel
 * in the queue metrics).
 */
export async function handleAuthEmailJob(job: AuthEmailJob): Promise<void> {
  switch (job.kind) {
    case 'password-reset':
      return handlePasswordReset(job.email);
    case 'registration':
      return handleRegistrationVerification(job.tokenHash); // ← Task 9 fills this in
  }
}

async function handlePasswordReset(email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  const redis = getRedis();

  // This worker runs OUTSIDE any request, so there is no ambient DB context and
  // no outer transaction: withSystemDbAccessContext establishes a real one (it
  // would be a SILENT NO-OP if a context were already active — it is not here).
  const eligibility = await getPasswordResetEligibility(normalizedEmail);

  if (!eligibility.allowed) {
    if (eligibility.reason === 'unknown_user') {
      // Expected. Not an error, not a retry. Log at warn for volume tracking
      // only — never audit an address that has no account.
      console.warn('[auth-email] password reset requested for a non-existent account');
      return;
    }
    // Known user, blocked by policy (SSO required / tenant inactive / disabled).
    await createAuditLog({
      orgId: null,
      actorType: 'system',
      actorId: ANONYMOUS_ACTOR_ID,
      action: 'user.password.reset.requested',
      resourceType: 'user',
      resourceId: eligibility.userId,
      details: { reason: eligibility.reason, ...(eligibility.detail ? { detail: eligibility.detail } : {}) },
      result: 'denied',
    });
    if (eligibility.reason === 'tenant_inactive') recordFailedLogin('reset_tenant_inactive');
    return;
  }

  if (!eligibility.userId || !eligibility.email || !redis) {
    // Fail CLOSED: an unreadable user id or a Redis outage means we cannot
    // create a single-use, generation-bound artifact. Do NOT send a link we
    // cannot bind. Throwing lets BullMQ retry (Redis may come back).
    throw new Error('[auth-email] password-reset preconditions unavailable (redis/user)');
  }

  const resetToken = nanoid(48);
  const tokenHash = createHash('sha256').update(resetToken).digest('hex');

  // SR2-08 envelope, unchanged — advance the generation and bind the token to
  // it plus the exact normalized address. Only the newest generation redeems.
  const gen = await withSystemDbAccessContext(() =>
    db.transaction(async (tx) => advanceUserEpochs(tx, eligibility.userId!, { passwordReset: true }))
  );
  await redis.setex(
    `reset:${tokenHash}`,
    3600,
    JSON.stringify({
      userId: eligibility.userId,
      passwordResetEpoch: gen.passwordResetEpoch,
      email: normalizedEmail,
    })
  );

  const appBaseUrl = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/$/, '');
  const resetUrl = `${appBaseUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;

  const emailService = getEmailService();
  if (!emailService) {
    // Observable + retryable without changing the (already-sent) public response.
    const err = new Error('[auth-email] email service not configured; password reset not sent');
    captureException(err);
    throw err;
  }
  await emailService.sendPasswordReset({ to: eligibility.email, resetUrl });

  await createAuditLog({
    orgId: null,
    actorType: 'system',
    actorId: ANONYMOUS_ACTOR_ID,
    action: 'user.password.reset.requested',
    resourceType: 'user',
    resourceId: eligibility.userId,
    details: {},
    result: 'success',
  });
}
```

Add the `Worker` construction + `initializeAuthEmailWorker`/`shutdownAuthEmailWorker` around it, and register both in `apps/api/src/index.ts` alongside the other workers (import near `:158-180`, call `initializeAuthEmailWorker()` in the same block the other `initialize*` calls live in, and `await shutdownAuthEmailWorker()` in the shutdown block — grep `shutdownOauthCleanupWorker` and mirror both call sites exactly).

**Note on the audit `orgId`.** The old in-request `writeAuthAudit` resolved an org from the request context; the worker has none. `createAuditLog` accepts `orgId: null` (that is how `register.ts:115` already writes its system audit). Do not try to reconstruct a request context in the worker.

- [ ] **Step 5: Rewrite `/forgot-password`**

Replace `apps/api/src/routes/auth/password.ts:79-182` in full:

```ts
// Forgot password — SR2-22.
//
// This handler does NO conditional work. It does not look the user up, does not
// advance an epoch, does not write a token, does not send mail. Every one of
// those is O(account exists) in wall-clock time, and the delta was measurable
// from the internet: a real user with SSO enforcement resolved a multi-join
// eligibility query and an argon2-free-but-still-heavy DB path, an unknown
// address returned immediately. The request now enqueues one opaque job and
// returns one fixed body; the worker (jobs/authEmailWorker.ts) does the
// conditional work where the requester cannot see it.
//
// Rate limiting stays, but the indistinguishability does NOT depend on it: the
// limiter is keyed on the CLIENT, and its exceeded-branch returns the very same
// 200 success body.
passwordRoutes.post('/forgot-password', zValidator('json', forgotPasswordSchema), async (c) => {
  const { email } = c.req.valid('json');
  const rateLimitClient = getClientRateLimitKey(c);
  const normalizedEmail = email.toLowerCase().trim();

  const GENERIC_ACCEPTED = {
    success: true as const,
    message: 'If this email exists, a reset link will be sent.',
  };

  const redis = getRedis();
  if (!redis) {
    // Service state, not account state — identical for every address.
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }
  const rateCheck = await rateLimiter(
    redis,
    `forgot:${rateLimitClient}`,
    forgotPasswordLimiter.limit,
    forgotPasswordLimiter.windowSeconds
  );
  if (!rateCheck.allowed) {
    return c.json(GENERIC_ACCEPTED);
  }

  try {
    await enqueuePasswordResetRequest(normalizedEmail);
  } catch (err) {
    // A queue failure must not change the public response shape (that would be
    // an availability oracle of its own). It IS observable server-side.
    console.error('[auth] failed to enqueue password-reset job:', err);
    captureException(err, c);
  }

  return c.json(GENERIC_ACCEPTED);
});
```

Add `import { enqueuePasswordResetRequest } from '../../services/authEmailQueue';` and `import { captureException } from '../../services/sentry';`. Then **delete the now-unused imports** from `password.ts`: `getPasswordResetEligibility` (the `ForUser` variant is still used by `/reset-password` — keep it), `recordFailedLogin`, `nanoid`, and `getEmailService` **only if** no other handler in the file uses them (grep before deleting; `/reset-password` still uses `createHash`, `advanceUserEpochs`, `revokeAllRefreshFamilies`, `runPostCommitCleanup`). `pnpm typecheck` is the arbiter.

**`password.test.ts` mock-queue hazard:** removing the eligibility call and the `db.transaction` from `/forgot-password` **removes two chains from the ordered Drizzle mock queue**. Re-prime the `mockReturnValueOnce` sequence in every `/reset-password` test in that file (they run after `/forgot-password` tests in file order and will shift). Do not delete assertions to make them pass.

- [ ] **Step 6: Run to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/authEmailQueue.test.ts src/jobs/authEmailWorker.test.ts src/routes/auth/password.test.ts && pnpm typecheck
```
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/authEmailQueue.ts apps/api/src/services/authEmailQueue.test.ts apps/api/src/jobs/authEmailWorker.ts apps/api/src/jobs/authEmailWorker.test.ts apps/api/src/routes/auth/password.ts apps/api/src/routes/auth/password.test.ts apps/api/src/index.ts
git commit -m "feat(auth): asynchronous forgot-password — no conditional in-request work, no timing oracle (SR2-22)"
```

---

### Task 6: SR2-17 schema — pending email + verification purpose

**Files:**
- Create: `apps/api/migrations/2026-07-18-pending-email-and-verification-purpose.sql`
- Modify: `apps/api/src/db/schema/users.ts` (after `emailEpoch`, `:69`)
- Modify: `apps/api/src/db/schema/emailVerificationTokens.ts` (after `emailEpoch`)

**Interfaces:**
- Produces: `users.pendingEmail` (`varchar(255)`, nullable), `users.pendingEmailRequestedAt` (`timestamptz`, nullable); `emailVerificationTokens.purpose` (`varchar(32) NOT NULL DEFAULT 'signup'`).
- **No new tables.** Both tables already have RLS enabled + forced + policies; adding columns changes nothing about their tenancy shape, so **`rls-coverage.integration.test.ts` needs no allowlist edit.** `pending_email` is deliberately NOT unique: two users may have the same address pending at once — the winner is whoever verifies first, and the loser's commit fails closed on the existing `users_email_unique` constraint (Task 8). That is the atomic "global email uniqueness" enforcement the design calls for; a unique index on `pending_email` would instead let the first *requester* squat an address they never proved.
- The migration sorts after the latest shipped file, `2026-07-17-sso-default-role-configured-by-on-delete.sql`.

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-07-18-pending-email-and-verification-purpose.sql`:

```sql
-- Core authentication hardening PR 4 (SR2-17): pending-email workflow.
-- Idempotent. No inner BEGIN/COMMIT (the runner wraps each file in a txn).
--
-- Changing an account email no longer moves users.email immediately. The
-- request records the requested address here and advances users.email_epoch;
-- the VERIFIED address in users.email stays authoritative for login, password
-- reset, CF Access matching and SSO matching until a verification token issued
-- for the pending address is redeemed. That closes the takeover where a stolen
-- session repoints the recovery address and the attacker then owns the account
-- outright, with no proof of control of the new mailbox.
--
-- pending_email is intentionally NOT UNIQUE: two accounts may request the same
-- address concurrently. Exactly one can COMMIT it — the swap runs against the
-- existing users_email_unique constraint, so the loser fails closed (23505).
-- A unique index here would instead let the first requester squat an address
-- they never proved control of.

ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email varchar(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email_requested_at timestamptz;

-- Verification tokens now serve two purposes. 'signup' is the historical one
-- (prove the address on a brand-new partner). 'email_change' proves control of
-- a PENDING address on an existing account; consume() branches on this and the
-- two branches have different live-row checks (signup matches users.email;
-- email_change matches users.pending_email and then SWAPS it in). Defaulting
-- pre-existing rows to 'signup' is correct: every row minted before this
-- migration was a signup token.
ALTER TABLE email_verification_tokens
  ADD COLUMN IF NOT EXISTS purpose varchar(32) NOT NULL DEFAULT 'signup';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_verification_tokens_purpose_chk'
  ) THEN
    ALTER TABLE email_verification_tokens
      ADD CONSTRAINT email_verification_tokens_purpose_chk
      CHECK (purpose IN ('signup', 'email_change'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS users_pending_email_idx ON users (pending_email)
  WHERE pending_email IS NOT NULL;
```

- [ ] **Step 2: Add the Drizzle columns**

`apps/api/src/db/schema/users.ts` — immediately after `emailEpoch: integer('email_epoch').notNull().default(1),`:

```ts
  // SR2-17: the address the user has ASKED to move to. users.email remains the
  // verified, authoritative identity (login, password reset, CF Access and SSO
  // all match on it and MUST NOT match this) until a purpose='email_change'
  // verification token proves control of this address. Cleared on commit and on
  // cancellation. Deliberately not unique — see the migration.
  pendingEmail: varchar('pending_email', { length: 255 }),
  pendingEmailRequestedAt: timestamp('pending_email_requested_at', { withTimezone: true }),
```

(`varchar` and `timestamp` are already imported in this file.)

`apps/api/src/db/schema/emailVerificationTokens.ts` — after `emailEpoch`:

```ts
    // 'signup' (prove the address on a new partner — the historical behaviour,
    // and the default for every pre-2026-07-18 row) or 'email_change' (prove
    // control of users.pending_email, then swap it in). consumeVerificationToken
    // branches on this; the two branches check DIFFERENT live-row columns.
    purpose: varchar('purpose', { length: 32 }).notNull().default('signup'),
```

- [ ] **Step 3: Apply the migration and verify no drift**

`pnpm db:migrate` is a **no-op** (`autoMigrate.ts` only exports the function). Apply ad-hoc:

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && pnpm exec tsx -e "import('./src/db/autoMigrate.ts').then(m => m.autoMigrate()).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })" && pnpm db:check-drift
```
Expected: migration applies; `db:check-drift` reports **no drift**.

- [ ] **Step 4: Prove the migration is idempotent and correctly ordered**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && psql "$DATABASE_URL" -f migrations/2026-07-18-pending-email-and-verification-purpose.sql && pnpm vitest run src/db/autoMigrate.test.ts
```
Expected: the direct re-apply is a clean no-op (no errors); `autoMigrate.test.ts` PASSES (confirms the filename sorts after `2026-07-17-*`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-07-18-pending-email-and-verification-purpose.sql apps/api/src/db/schema/users.ts apps/api/src/db/schema/emailVerificationTokens.ts
git commit -m "feat(auth): pending_email columns + verification-token purpose discriminator (SR2-17)"
```

---

### Task 7: SR2-17 + SR2-18 — `PATCH /users/me` records a PENDING email and requires a recovery-grade step-up

**Files:**
- Create: `apps/api/src/services/pendingEmail.ts`, `apps/api/src/services/pendingEmail.test.ts`
- Modify: `apps/api/src/routes/users.ts:433-713` (`PATCH /me`)
- Modify: `apps/api/src/middleware/auth.ts:125-140` (`isMfaEnrollmentExemptPath`) — see the SR2-18 gate below
- Modify: `apps/api/src/services/email.ts:309` (`sendEmailChanged` gains `pending`)
- Test: `apps/api/src/routes/users.test.ts` (grep for the existing `PATCH /me` email-change describe block)
- Modify (i18n): `apps/web/src/locales/{en,pt-BR,de-DE,es-419,fr-FR}/settings.json` + the settings email-change component

**Interfaces:**
- Produces `apps/api/src/services/pendingEmail.ts`:
  - `export interface PendingEmailRequest { userId: string; partnerId: string; newEmail: string; }`
  - `export async function requestPendingEmailChange(req: PendingEmailRequest): Promise<{ rawToken: string; emailEpoch: number }>` — in ONE transaction: write `pending_email` + `pending_email_requested_at`, `advanceUserEpochs(tx, userId, { email: true })`, and `invalidateOpenTokens(userId)`-equivalent supersede of that user's open verification tokens. Returns the raw token minted by a purpose-aware `generateVerificationToken({ …, purpose: 'email_change', email: newEmail })` (Task 8 adds the `purpose` param).
  - **Fails closed:** if the `UPDATE … RETURNING` matches 0 rows (RLS filtered the row out), throw — never mint a token for a row you could not write.
- Consumes: `advanceUserEpochs` (`services/authLifecycle.ts`), `generateVerificationToken` (`services/emailVerification.ts`), `enforceExistingFactorStepUp` + `requireCurrentPasswordStepUp` + `userIsMfaProtected` (`routes/auth/helpers.ts`), `getEffectiveMfaPolicy` (`services/mfaPolicy.ts`).
- Produces (route contract): `PATCH /users/me` with `{ email }` now returns **`200 { pendingEmail, pendingEmailRequestedAt, verificationSent: true }`** and the returned `user.email` is **unchanged**. The address does not move.

**The three gates, all fail-closed.**

1. **SSO-enforced org** — unchanged (`users.ts:525`): 403, email is managed at the IdP.
2. **SR2-18 forced-enrollment gate (NEW).** A user parked in `mfa_enrollment_required` may currently PATCH their email: `isMfaEnrollmentExemptPath` (`middleware/auth.ts:131`) exempts `/users/me` wholesale so they can finish enrolling. That exemption exists to let them **enroll a factor**, not to let them move their **recovery address** — the design is explicit: "Forced-enrollment exemptions permit only the operations needed to finish MFA enrollment; they do not permit recovery-email mutation." Implement the gate **in the handler, not the middleware** (the middleware sees the path, not the body — narrowing the path exemption would break `GET /users/me`, which the enrollment UI needs):

```ts
    // SR2-18: a user under a required-MFA policy who has NOT yet enrolled is
    // admitted to /users/me ONLY so they can finish enrolling (see
    // isMfaEnrollmentExemptPath in middleware/auth.ts). They must not be able
    // to move the account's RECOVERY ADDRESS from inside that exemption — that
    // would let a session stolen before enrollment repoint recovery and defeat
    // the whole forced-enrollment gate. Fail CLOSED: an unresolvable policy
    // (null/throw) denies too.
    const policy = await getEffectiveMfaPolicy({
      scope: auth.scope, userId: auth.user.id, orgId: auth.orgId, partnerId: auth.partnerId,
    });
    if (policy.required && !(await userIsMfaProtected(auth.user.id))) {
      return c.json({ error: 'mfa_enrollment_required', enrollUrl: '/auth/mfa/setup' }, 403);
    }
```
3. **SR2-18 recovery-grade step-up (STRENGTHENED).** Today (`users.ts:529-543`) the handler requires **either** current-password (if the user has one) **or** satisfied MFA (if passwordless). The design requires "current-password **and** fresh-MFA step-up". Replace with:

```ts
      // SR2-18: an email change moves the account's recovery surface — the new
      // address can drive /forgot-password and MFA recovery — so it demands the
      // SAME assurance as adding an MFA factor, not less.
      //
      //   (a) local-password user: current password, verified against argon2;
      //   (b) MFA-PROTECTED user (any factor): additionally a FRESH existing-
      //       factor step-up grant, bound to the live epochs + this session's
      //       sid. `hasSatisfiedMfa(auth)` is NOT sufficient: that is a claim on
      //       a token that may be hours old and was minted before this session
      //       was stolen. The grant is single-use and minted seconds ago by
      //       POST /auth/mfa/step-up.
      //   (c) passwordless AND unprotected (SSO-only account with no factor and
      //       no password): there is nothing to step up with → DENY. Previously
      //       this fell into the `hasSatisfiedMfa` branch and could pass with a
      //       vacuous mfa=true claim.
      if (self.passwordHash) {
        if (!body.currentPassword) {
          return c.json({ error: 'Current password is required to change your email address.' }, 400);
        }
        const stepUp = await requireCurrentPasswordStepUp(c, auth.user.id, body.currentPassword, 'email-change:pwd');
        if (stepUp) return stepUp;
        stepUpMethod = 'password';
      } else if (!(await userIsMfaProtected(auth.user.id))) {
        return c.json({ error: 'This account cannot change its email address here.' }, 403);
      }

      // enforceExistingFactorStepUp is a NO-OP for an account with no factor
      // (initial-enrollment chicken-and-egg), and a hard 403 for a protected
      // account without a fresh grant. consume: true — single use, terminal.
      const factorStepUp = await enforceExistingFactorStepUp(c, auth, body.stepUpGrantId, { consume: true });
      if (factorStepUp) return factorStepUp;
      if (!stepUpMethod) stepUpMethod = 'mfa';
```
   `updateMeSchema` (`users.ts:399-413`) gains `stepUpGrantId: z.string().uuid().optional(),` with the same "NEVER persisted, excluded from audit changedFields" comment `currentPassword` carries.

**What the write does now (Q2 default).** Initiation advances **`email_epoch` only** — it does **not** advance `auth_epoch` and does **not** revoke refresh families (that would sign the user out mid-flow, before they can click the link). The address has not moved, so the recovery surface has not actually changed yet. `auth_epoch` + family revocation happen at **commit** (Task 8). The `email_epoch` advance at initiation is still load-bearing: it invalidates every verification artifact bound to the previous generation, so a stale link cannot be redeemed against the new pending state.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/pendingEmail.test.ts` (new) — mock `../db`, `./authLifecycle`, `./emailVerification`:

```ts
it('writes pending_email + pending_email_requested_at, advances ONLY email_epoch, and mints an email_change token', async () => {
  const out = await requestPendingEmailChange({ userId: 'u1', partnerId: 'p1', newEmail: 'new@corp.com' });
  expect(setCalls[0]).toMatchObject({ pendingEmail: 'new@corp.com' });
  expect(setCalls[0].pendingEmailRequestedAt).toBeInstanceOf(Date);
  // users.email is NOT touched — that is the whole finding.
  expect(setCalls[0]).not.toHaveProperty('email');
  expect(vi.mocked(advanceUserEpochs)).toHaveBeenCalledWith(expect.anything(), 'u1', { email: true });
  expect(vi.mocked(generateVerificationToken)).toHaveBeenCalledWith(
    expect.objectContaining({ userId: 'u1', email: 'new@corp.com', purpose: 'email_change' })
  );
  expect(out.rawToken).toBe('raw-token-mock');
});

it('fails closed when the pending-email UPDATE matches 0 rows (RLS-filtered)', async () => {
  updateReturning.mockResolvedValueOnce([]);          // 0 rows
  await expect(requestPendingEmailChange({ userId: 'u1', partnerId: 'p1', newEmail: 'new@corp.com' }))
    .rejects.toThrow(/pending email/i);
  expect(vi.mocked(generateVerificationToken)).not.toHaveBeenCalled();
});
```

`apps/api/src/routes/users.test.ts` — in the existing `PATCH /me` email-change describe block:

```ts
it('SR2-17: does NOT move users.email; records a pending address instead', async () => {
  const res = await patchMe({ email: 'new@corp.com', currentPassword: 'pw', stepUpGrantId: GRANT });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.email).toBe('old@corp.com');            // unchanged!
  expect(body.pendingEmail).toBe('new@corp.com');
  expect(body.verificationSent).toBe(true);
  // The killer assertion: no UPDATE ever set `email`.
  expect(updateSetCalls.every((s) => !('email' in s))).toBe(true);
});

it('SR2-17: does NOT sign the user out at initiation (auth_epoch untouched, families intact)', async () => {
  await patchMe({ email: 'new@corp.com', currentPassword: 'pw', stepUpGrantId: GRANT });
  expect(vi.mocked(advanceUserEpochs)).toHaveBeenCalledWith(expect.anything(), 'user-1', { email: true });
  expect(vi.mocked(revokeAllRefreshFamilies)).not.toHaveBeenCalled();
});

it('SR2-18: an MFA-protected user with NO fresh step-up grant is refused', async () => {
  vi.mocked(userIsMfaProtected).mockResolvedValue(true);
  const res = await patchMe({ email: 'new@corp.com', currentPassword: 'pw' });   // no grant
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ error: 'existing_factor_step_up_required' });
  expect(updateSetCalls.length).toBe(0);
});

it('SR2-18: a forced-enrollment user (policy required, unenrolled) cannot move the recovery address', async () => {
  vi.mocked(getEffectiveMfaPolicy).mockResolvedValue({ required: true, allowedMethods: { totp: true, sms: true, passkey: true } });
  vi.mocked(userIsMfaProtected).mockResolvedValue(false);
  const res = await patchMe({ email: 'new@corp.com', currentPassword: 'pw' });
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ error: 'mfa_enrollment_required' });
  expect(updateSetCalls.length).toBe(0);
});

it('SR2-18: a passwordless, factor-less account is refused outright (no vacuous mfa=true pass)', async () => {
  selfRow.passwordHash = null;
  vi.mocked(userIsMfaProtected).mockResolvedValue(false);
  vi.mocked(getEffectiveMfaPolicy).mockResolvedValue({ required: false, allowedMethods: { totp: true, sms: true, passkey: true } });
  const res = await patchMe({ email: 'new@corp.com' });
  expect(res.status).toBe(403);
  expect(updateSetCalls.length).toBe(0);
});

it('a name-only PATCH still works and touches no epoch', async () => {
  const res = await patchMe({ name: 'New Name' });
  expect(res.status).toBe(200);
  expect(vi.mocked(advanceUserEpochs)).not.toHaveBeenCalled();
});

it('notifies the OLD address that a change was REQUESTED', async () => {
  await patchMe({ email: 'new@corp.com', currentPassword: 'pw', stepUpGrantId: GRANT });
  expect(sendEmailChanged).toHaveBeenCalledWith(
    expect.objectContaining({ to: 'old@corp.com', newEmail: 'new@corp.com', pending: true })
  );
});
```

Guard-bites, one per gate: delete the forced-enrollment check → test 4 RED; delete the `enforceExistingFactorStepUp` call → test 3 RED; restore the `updates.email = normalizedEmail` write → test 1 RED; drop the passwordless-unprotected deny → test 5 RED. **Each gate has its own bite.**

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/pendingEmail.test.ts src/routes/users.test.ts -t 'SR2-1'
```
Expected: FAIL — `pendingEmail.ts` does not exist; `PATCH /me` still writes `users.email`.

- [ ] **Step 3: Implement `services/pendingEmail.ts`**

```ts
import { eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { users } from '../db/schema';
import { advanceUserEpochs } from './authLifecycle';
import { generateVerificationToken, invalidateOpenTokens } from './emailVerification';

const { db } = dbModule;

export interface PendingEmailRequest {
  userId: string;
  partnerId: string;
  newEmail: string;
}

/**
 * SR2-17 initiation. Records the REQUESTED address and advances email_epoch —
 * it does NOT move users.email, does NOT advance auth_epoch and does NOT revoke
 * refresh families. The verified address remains authoritative for login,
 * password reset, CF Access and SSO matching until the token minted here is
 * redeemed (services/emailVerification.ts, purpose='email_change').
 *
 * Runs in the CALLER's request context — this is a self-service handler writing
 * the caller's OWN users row, which the self policy admits. Do NOT wrap in
 * withSystemDbAccessContext: inside an already-active context that is a SILENT
 * NO-OP anyway, and there is no need to escalate.
 *
 * FAILS CLOSED: a 0-row UPDATE means RLS filtered the row (or the user vanished)
 * — we throw rather than mint a verification token for a state we never wrote.
 */
export async function requestPendingEmailChange(
  req: PendingEmailRequest,
): Promise<{ rawToken: string; emailEpoch: number }> {
  const newEmail = req.newEmail.toLowerCase().trim();
  const now = new Date();

  const emailEpoch = await db.transaction(async (tx) => {
    const rows = await tx
      .update(users)
      .set({ pendingEmail: newEmail, pendingEmailRequestedAt: now, updatedAt: now })
      .where(eq(users.id, req.userId))
      .returning({ id: users.id });
    if (rows.length === 0) {
      throw new Error(`requestPendingEmailChange: pending email write matched 0 rows for ${req.userId}`);
    }
    // Advancing email_epoch here invalidates every verification artifact bound
    // to the PREVIOUS generation — including an older pending-email link the
    // user is now replacing. The token minted below carries the NEW epoch.
    const epochs = await advanceUserEpochs(tx, req.userId, { email: true });
    return epochs.emailEpoch;
  });

  // Supersede any still-open token (a prior pending change, or an unfinished
  // signup link) so exactly one live link exists per user.
  await invalidateOpenTokens(req.userId);

  const rawToken = await generateVerificationToken({
    partnerId: req.partnerId,
    userId: req.userId,
    email: newEmail,
    purpose: 'email_change',
  });

  return { rawToken, emailEpoch };
}
```

(The `purpose` param on `generateVerificationToken` is added in Task 8. If you are executing Tasks 7 and 8 in separate sessions, add the optional param — `purpose?: 'signup' | 'email_change'`, defaulting `'signup'` — as a one-line change here and let Task 8 build the consume branch on it. `pnpm typecheck` will tell you.)

- [ ] **Step 4: Rewrite the `PATCH /me` email branch**

In `apps/api/src/routes/users.ts`, extend `updateMeSchema` with `stepUpGrantId`, replace the step-up block (`:520-556`) with the three gates above, and replace the write block (`:592-622`) with:

```ts
  // SR2-17: the email is NOT written here. `updates` never carries `email`.
  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, auth.user.id))
    .returning(returningColumns);

  if (!updated) {
    return c.json({ error: 'Failed to update profile' }, 500);
  }

  // SR2-17: a genuine email change is a PENDING request, committed only by the
  // verification click. Done after the name/preferences write so a failure here
  // cannot half-apply an unrelated profile edit.
  let pendingEmailOut: string | undefined;
  if (pendingNewEmail) {
    const { rawToken } = await requestPendingEmailChange({
      userId: auth.user.id,
      partnerId: auth.partnerId ?? selfPartnerId,   // add partnerId to the `self` select
      newEmail: pendingNewEmail,
    });
    pendingEmailOut = pendingNewEmail;

    const appBaseUrl = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/$/, '');
    const verificationUrl = `${appBaseUrl}/auth/verify-email?token=${encodeURIComponent(rawToken)}`;
    const emailService = getEmailService();
    if (emailService) {
      // To the NEW address: prove you control it.
      await emailService.sendVerificationEmail({ to: pendingNewEmail, name: updated.name, verificationUrl })
        .catch((err) => { console.error('[users] pending-email verification send failed', err); captureException(err); });
      // To the OLD address: a change was REQUESTED (Q3). Fires at INITIATION,
      // not only on completion — the owner of the address being abandoned must
      // hear about it while they can still act, not after the swap.
      await emailService.sendEmailChanged({ to: previousEmail!, name: updated.name, newEmail: pendingNewEmail, pending: true })
        .catch((err) => { console.error('[users] pending-email security notice failed', err); captureException(err); });
    }
  }
```
Rename the existing `previousEmail` bookkeeping to also set a new `pendingNewEmail` variable in the gate block (it replaces `updates.email = normalizedEmail`). Keep the **uniqueness pre-check** (`users.ts:548-555`) — it is a UX nicety that 409s early; it is **not** the security control (that is the `users_email_unique` constraint at commit, Task 8). Add `pendingEmail: pendingEmailOut` and `verificationSent: !!pendingEmailOut` to the `c.json(updated)` response.

The dedicated `user.email.change` audit (`:667-694`) becomes `user.email.change.requested` with `details: { previousEmail, pendingEmail, stepUp: stepUpMethod }`. **Drop** `sessionsRevoked`/`redisCutoffOk`/`oauthGrantsRevokedOk` from it (nothing is revoked at initiation) — those move to the commit audit in Task 8. Delete the now-dead `runPostCommitCleanup`/`revokeAllRefreshFamilies` calls from this handler.

`apps/api/src/services/email.ts:309` — `sendEmailChanged(params: EmailChangedEmailParams & { pending?: boolean })`: when `pending` is true the subject/body says a change was **requested** and names the verification requirement; otherwise it keeps today's completed-change copy. Add both string sets; they are server-side email copy, **not** i18n keys (the email templates are not translated in this repo — confirm by reading `email.ts` and if they ARE translated, add all five locales).

- [ ] **Step 5: Web — the settings email-change form sends the grant**

The settings profile form must now (a) send `stepUpGrantId` after driving `POST /auth/mfa/step-up` for an MFA-protected user, and (b) render a "we sent a link to `<new address>` — your email will change once you confirm" state instead of optimistically showing the new address. Find the component with `grep -rln "currentPassword" apps/web/src/components/settings`. Wrap the PATCH in `runAction` (`apps/web/src/lib/runAction.ts`) per the repo convention, and if the handler count changes, reconcile `apps/web/src/lib/runActionAllowlist.ts` + `no-silent-mutations.test.ts` in this same commit. **New strings go into ALL FIVE `apps/web/src/locales/*/settings.json`** — `en`, `pt-BR`, `de-DE`, `es-419`, `fr-FR`. The `localeParity` test fails on any missing key.

- [ ] **Step 6: Run to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/pendingEmail.test.ts src/routes/users.test.ts && pnpm typecheck
cd ../web && pnpm vitest run src/components/settings src/lib
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/pendingEmail.ts apps/api/src/services/pendingEmail.test.ts apps/api/src/routes/users.ts apps/api/src/routes/users.test.ts apps/api/src/services/email.ts apps/web/src/components/settings apps/web/src/locales
git commit -m "feat(auth): email change records a PENDING address behind password + fresh-factor step-up (SR2-17, SR2-18)"
```

---

### Task 8: SR2-17 — verification commits the pending email atomically; the IdPs never match it

**Files:**
- Modify: `apps/api/src/services/emailVerification.ts` (`generateVerificationToken` `:45`, `consumeVerificationToken` `:102`)
- Modify: `apps/api/src/routes/auth/verifyEmail.ts:25-76`
- Test: `apps/api/src/services/emailVerification.test.ts`, `apps/api/src/routes/auth/verifyEmail.test.ts`
- Test (IdP non-matching): `apps/api/src/middleware/cfAccessLogin.test.ts`, `apps/api/src/routes/sso.test.ts`
- Modify (i18n): `apps/web/src/components/auth/VerifyEmailPage.tsx` + all five `auth.json`

**Interfaces:**
- `generateVerificationToken(input: GenerateTokenInput)` — `GenerateTokenInput` gains `purpose?: 'signup' | 'email_change'` (default `'signup'`), persisted to the new column.
- `ConsumeFailureReason` gains `'email_taken'` (the pending address was claimed by someone else between request and click) and `'no_pending_email'` (the pending state was cancelled/replaced).
- `ConsumeResult` (ok branch) gains `purpose: 'signup' | 'email_change'` and, for `email_change`, `previousEmail: string`.
- `consumeVerificationToken` branches on `row.purpose`:
  - **`'signup'`** — unchanged behaviour (match `users.email` + `email_epoch`, stamp `email_verified_at`, maybe auto-activate the partner).
  - **`'email_change'`** — NEW branch, described below.

**The `email_change` commit, inside the existing `db.transaction` + `withSystemDbAccessContext`:**

```ts
      // SR2-17 commit. The token proves control of the PENDING address only.
      //
      // `FOR UPDATE` on the users row is load-bearing (same reason the signup
      // branch takes it): without it, an email change committing concurrently
      // is a check-then-act and this stale token could swap in an address the
      // user has since abandoned.
      const [liveUser] = await tx
        .select({
          email: users.email,
          pendingEmail: users.pendingEmail,
          emailEpoch: users.emailEpoch,
          name: users.name,
        })
        .from(users)
        .where(eq(users.id, row.userId))
        .limit(1)
        .for('update');

      if (!liveUser) return { ok: false, error: 'superseded' as const };

      // The pending state must still exist, must still be the address this
      // token was issued for, and must still be the generation it was issued
      // under. Any cancellation/replacement advanced email_epoch and fails here.
      if (!liveUser.pendingEmail) {
        return { ok: false, error: 'no_pending_email' as const };
      }
      if (
        liveUser.pendingEmail.toLowerCase() !== row.email.toLowerCase() ||
        row.emailEpoch === null ||
        row.emailEpoch !== liveUser.emailEpoch
      ) {
        // NOTE: unlike the signup branch, a NULL token epoch is NOT tolerated
        // here. No purpose='email_change' row can predate the 2026-07-18
        // migration, so a NULL epoch on one is corruption — fail closed.
        return { ok: false, error: 'address_changed' as const };
      }

      const claimed = await tx
        .update(emailVerificationTokens)
        .set({ consumedAt: now })
        .where(and(
          eq(emailVerificationTokens.id, row.id),
          isNull(emailVerificationTokens.consumedAt),
          isNull(emailVerificationTokens.supersededAt),
        ))
        .returning({ id: emailVerificationTokens.id });
      if (claimed.length === 0) return { ok: false, error: 'consumed' as const };

      const previousEmail = liveUser.email;

      // THE SWAP. Global email uniqueness is enforced by the existing
      // users_email_unique constraint — if another account took this address
      // while the link sat in a mailbox, this UPDATE raises 23505 and the whole
      // transaction (including the token claim) rolls back. That is the atomic
      // "exactly one winner" the design requires: we do NOT pre-check-then-write.
      try {
        await tx
          .update(users)
          .set({
            email: liveUser.pendingEmail,
            emailVerifiedAt: now,
            pendingEmail: null,
            pendingEmailRequestedAt: null,
            updatedAt: now,
          })
          .where(eq(users.id, row.userId));
      } catch (err) {
        if (isUniqueViolation(err)) return { ok: false, error: 'email_taken' as const };
        throw err;
      }

      // The recovery surface has NOW moved. Advance auth_epoch (every access
      // token minted for the old identity dies on its next request) and
      // email_epoch (every other outstanding artifact bound to this address
      // dies), and durably revoke every refresh family — all inside THIS
      // transaction, so a rollback undoes the sign-out with the swap.
      await advanceUserEpochs(tx, row.userId, { auth: true, email: true });
      await revokeAllRefreshFamilies(tx, row.userId, 'email-change-committed');

      return {
        ok: true as const,
        purpose: 'email_change' as const,
        partnerId: row.partnerId,
        userId: row.userId,
        email: liveUser.pendingEmail,
        previousEmail,
        autoActivated: false,
      };
```
Add a local `isUniqueViolation(err)` helper (postgres.js surfaces `err.code === '23505'`; grep the repo for an existing helper before writing one — `grep -rn "23505" apps/api/src`). **Note the transaction rollback semantics:** a caught-and-returned 23505 inside `db.transaction` still rolls the transaction back in postgres.js — verify in Task 11's real-DB test that the token is NOT left consumed after an `email_taken` outcome, and if postgres.js has already aborted the tx, restructure to run the swap in its own inner savepoint. **Do not assume — the real-DB test decides.**

After the transaction commits, `routes/auth/verifyEmail.ts` calls `runPostCommitCleanup(result.userId)` (Redis JWT cutoff + permission-cache clear + MCP OAuth grant sweep — the EdDSA bearer path never sees user-JWT epochs, so those grants must be swept out-of-band) and sends `sendEmailChanged({ to: result.previousEmail, newEmail: result.email, pending: false })` — the completion notice (Q3).

**IdP non-matching (design: "an IdP asserting the pending (unverified) address must not match").** `cfAccessLogin.ts:103` and the SSO user resolution both `WHERE users.email = <asserted>`. Because `pending_email` is a *separate column*, they already cannot match it. That is a property to **pin with a test**, not to implement — it would be silently lost the day someone "helpfully" adds an `OR pending_email = …` for convenience.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/emailVerification.test.ts`:
```ts
it('email_change: swaps the address, clears pending, advances auth+email epochs, revokes families', async () => { /* … */ });
it('email_change: a token whose email_epoch has moved on is rejected (address_changed)', async () => { /* … */ });
it('email_change: a token for a user with NO pending_email is rejected (no_pending_email)', async () => { /* … */ });
it('email_change: a NULL token epoch is rejected outright (unlike the signup branch)', async () => { /* … */ });
it('signup: behaviour is byte-for-byte unchanged (regression)', async () => { /* re-run the existing signup cases */ });
```
`apps/api/src/routes/auth/verifyEmail.test.ts`: an `email_change` success returns `{ verified: true, purpose: 'email_change', email }`; every failure reason maps to the **same generic 400** (`{ error: 'Invalid or expired verification link' }`) — do **not** return `no_pending_email` / `email_taken` / `address_changed` to the client verbatim; those are audit-only reasons. Pin that:
```ts
it('every failure reason produces one identical public body', async () => {
  for (const reason of ['invalid', 'expired', 'consumed', 'superseded', 'address_changed', 'no_pending_email', 'email_taken'] as const) {
    vi.mocked(consumeVerificationToken).mockResolvedValueOnce({ ok: false, error: reason });
    const res = await postVerify({ token: 't' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid or expired verification link' });
  }
});
```
(The current handler returns `{ error: result.error }` — leaking the reason string. That is a small enumeration leak of its own: `address_changed` vs `invalid` tells the holder of a random token whether the token existed.)

**IdP guard-bite** — in `cfAccessLogin.test.ts`:
```ts
it('an IdP asserting the PENDING (unverified) address does not match the user', async () => {
  // The users lookup must be keyed on users.email ONLY. Seed the mock so the
  // select returns [] for the pending address, and assert the middleware falls
  // through to password auth (next()) rather than minting a session.
  selectChain.limit.mockResolvedValueOnce([]);         // no row for pending@corp.com
  await callCfAccessLogin({ claimsEmail: 'pending@corp.com' });
  expect(vi.mocked(createTokenPair)).not.toHaveBeenCalled();
  expect(nextSpy).toHaveBeenCalled();
});
```
and the structural bite that actually survives a refactor:
```bash
# Add to the same test file as an assertion, or as a standalone contract test:
grep -rn "pendingEmail\|pending_email" apps/api/src/middleware/cfAccessLogin.ts apps/api/src/routes/sso.ts
# must produce ZERO hits — the IdP paths must never read the pending address.
```
Encode that grep as a Vitest contract test (read the file with `fs.readFileSync` and assert `!/pending_?[eE]mail/.test(src)`), in `apps/api/src/services/pendingEmail.test.ts`. **That is the guard-bite**: the day someone adds an `OR pending_email` to an IdP matcher, it goes RED.

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/emailVerification.test.ts src/routes/auth/verifyEmail.test.ts src/services/pendingEmail.test.ts
```
Expected: FAIL — no `purpose` branch; the verify route still echoes the raw failure reason.

- [ ] **Step 3: Implement** (the code blocks above; `verifyEmail.ts` gains the purpose dispatch, the generic 400, the `runPostCommitCleanup` call, the completion notice, and an `auth.email.change.committed` audit carrying `{ previousEmail, newEmail }` + the cleanup outcome flags).

- [ ] **Step 4: Web**

`apps/web/src/components/auth/VerifyEmailPage.tsx` renders a distinct success message for `purpose === 'email_change'` ("Your email address has been updated. Please sign in again." — the user IS signed out by the family revoke, so the page must send them to `/login`). **New strings → ALL FIVE `apps/web/src/locales/*/auth.json`.**

- [ ] **Step 5: Run to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/emailVerification.test.ts src/routes/auth/verifyEmail.test.ts src/services/pendingEmail.test.ts src/middleware/cfAccessLogin.test.ts src/routes/sso.test.ts && pnpm typecheck
cd ../web && pnpm vitest run src/components/auth src/lib/i18n
```
Expected: PASS. **`sso.test.ts` mock hazard:** if the SSO suite's ordered Drizzle queue shifts because you touched `sso.ts`, re-prime it — you should not need to touch `sso.ts` at all in this task.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/emailVerification.ts apps/api/src/services/emailVerification.test.ts apps/api/src/routes/auth/verifyEmail.ts apps/api/src/routes/auth/verifyEmail.test.ts apps/api/src/services/pendingEmail.test.ts apps/web/src/components/auth/VerifyEmailPage.tsx apps/web/src/locales
git commit -m "feat(auth): verification commits the pending email atomically and signs the user out; IdPs never match a pending address (SR2-17)"
```

---

### Task 9: SR2-21 — email-first partner registration (API)

**Files:**
- Create: `apps/api/src/services/pendingRegistration.ts`, `apps/api/src/services/pendingRegistration.test.ts`
- Modify: `apps/api/src/routes/auth/register.ts:89-410` (`/register-partner`)
- Modify: `apps/api/src/jobs/authEmailWorker.ts` (fill in the `registration` case declared in Task 5)
- Modify: `apps/api/src/routes/auth/verifyEmail.ts` (a pending-registration token is a THIRD verification kind)
- Modify: `apps/api/src/services/email.ts` — add `sendSignupAttemptOnExistingAccount({ to, name })`
- Test: `apps/api/src/routes/auth/register.test.ts`

**Interfaces:**
- Produces `apps/api/src/services/pendingRegistration.ts`:
  - `export interface PendingRegistration { email: string; companyName: string; name: string; passwordHash: string; acceptTerms: boolean; termsVersion: string; hostedExpectation: boolean; createdAt: number; signupIp?: string; signupUserAgent?: string; }`
  - `export async function createPendingRegistration(record: Omit<PendingRegistration,'createdAt'>): Promise<{ rawToken: string; tokenHash: string }>` — `rawToken = randomBytes(32).toString('base64url')` (**≥256 bits**, per the design), stored at `pending-reg:${sha256(rawToken)}` with `SETEX … 3600`. Returns both.
  - `export async function consumePendingRegistration(tokenHash: string): Promise<PendingRegistration | null>` — atomic `GETDEL` (fall back to the same `EVAL` GET+DEL script `password.ts:65-73` uses when `getdel` is absent). **Exactly one winner** under concurrency.
  - `export async function peekPendingRegistration(tokenHash: string): Promise<PendingRegistration | null>` — non-consuming `GET`, used by the **worker** (which must read the record to send the email but must NOT consume it — the user's click consumes it).
  - Fails closed: no Redis ⇒ `createPendingRegistration` throws (the route maps that to the existing generic 503 and creates nothing).
- Produces (route contract): `POST /auth/register-partner` returns **only** `200 { success: true, message: 'If registration can proceed, you will receive next steps shortly.' }` on every accepted request. No `user`, no `partner`, no `tokens`, no `slug`, no `verificationEmailSent`, no `redirectUrl`. The only other outcomes are the pre-existing `403` (self-hosted setup gate — not email-dependent), `429` (rate limit — client-keyed), `400` (password strength / body validation — input-dependent, not account-dependent) and `503` (Redis down).

**What is deleted from the request path.** The `db.select` existence check (`register.ts:166-174`), `createPartner`, the partner/user re-fetch, `mintRefreshTokenFamily` + `getUserEpochs` + `createTokenPair` + `bindRefreshJtiToFamily` + `setRefreshTokenCookie`, `generateVerificationToken`, the email send, and `dispatchHook` — **all of it moves to step 2 (verification) or to the worker.** After this task the handler does: gate → rate limit → password strength → `hashPassword` → `createPendingRegistration` (Redis SETEX) → `enqueueRegistrationVerification(tokenHash)` → generic 200.

**Step-1 abuse attribution (#2343) — the whole point of storing it.** `signupIp` / `signupUserAgent` are captured from the **live step-1 request** (`getTrustedClientIpOrUndefined(c)` and `c.req.header('user-agent')`) and stored in the Redis record. Step 2 passes **those** into `createPartner({ origin: { mcp: false, ip: rec.signupIp, userAgent: rec.signupUserAgent } })` — **never** the verification click's IP/UA. The click routinely comes from a mail client, a corporate link scanner, or a Microsoft Safe Links prefetch in another country; using it would silently corrupt the entire signup-abuse-signal corpus. Pin it with a test.

**Uniformity contract (explicit).** For any two syntactically valid bodies with the same password strength — one whose email has an account, one whose does not — `POST /auth/register-partner` performs **the identical sequence of operations**: `isPasswordStrong` → `hashPassword` (argon2, the dominant cost) → one Redis `SETEX` → one queue `add` → the same 200 body. There is **no branch on the email** and **no DB read**. Uniform latency follows structurally, not from a floor (Q6).

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/pendingRegistration.test.ts` — token entropy, `SETEX` key shape + 3600 TTL, `GETDEL` single-winner (two concurrent consumes → one record, one `null`), no-Redis throw.

`apps/api/src/routes/auth/register.test.ts` — **rewrite the `/register-partner` block for the two-step contract**:

```ts
describe('POST /register-partner — SR2-21: email-first, no account created before verification', () => {
  it('creates NO partner, NO user, NO tokens, and sets NO cookie', async () => {
    const res = await postRegisterPartner(VALID_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      message: 'If registration can proceed, you will receive next steps shortly.',
    });
    expect(vi.mocked(createPartner)).not.toHaveBeenCalled();
    expect(vi.mocked(createTokenPair)).not.toHaveBeenCalled();
    expect(vi.mocked(mintRefreshTokenFamily)).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('performs NO user-existence lookup (that lookup WAS the oracle)', async () => {
    await postRegisterPartner(VALID_BODY);
    // db.select is still used by the SELF-HOSTED setup gate. In hosted mode
    // (isHosted() -> true, the mode this suite runs) there must be ZERO selects.
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  it('returns the byte-identical body whether or not the address has an account', async () => {
    const a = await postRegisterPartner({ ...VALID_BODY, email: 'brand-new@corp.com' });
    const b = await postRegisterPartner({ ...VALID_BODY, email: 'already-registered@corp.com' });
    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
  });

  it('stores the step-1 attribution (trusted IP + UA) in the pending record', async () => {
    await postRegisterPartner(VALID_BODY);
    expect(vi.mocked(createPendingRegistration)).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'new@corp.com',
        passwordHash: 'hashed',
        signupIp: '127.0.0.1',                 // from the mocked getTrustedClientIpOrUndefined
        signupUserAgent: expect.any(String),
      })
    );
  });

  it('enqueues the verification job with the token HASH, never the raw token', async () => {
    await postRegisterPartner(VALID_BODY);
    const [arg] = vi.mocked(enqueueRegistrationVerification).mock.calls[0];
    expect(arg).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Redis down: the generic 503 and NO pending record', async () => {
    vi.mocked(getRedis).mockReturnValueOnce(null);
    const res = await postRegisterPartner(VALID_BODY);
    expect(res.status).toBe(503);
    expect(vi.mocked(createPendingRegistration)).not.toHaveBeenCalled();
  });
});
```
**Guard-bite:** restore the `db.select` existence check → test 2 RED. Restore `createPartner` in the request → test 1 RED.

`apps/api/src/jobs/authEmailWorker.test.ts` — the `registration` case:
```ts
it('an address with NO account: sends the signup-verification link', async () => { /* peek → users lookup empty → sendVerificationEmail */ });
it('an address WITH an account: sends the "someone tried to sign up" notice instead, and does NOT send a signup link (Q5 option b)', async () => { /* … sendSignupAttemptOnExistingAccount */ });
it('the pending record is NOT consumed by the worker (only the click consumes it)', async () => {
  await handleAuthEmailJob({ kind: 'registration', tokenHash: 'h' });
  expect(vi.mocked(consumePendingRegistration)).not.toHaveBeenCalled();
  expect(vi.mocked(peekPendingRegistration)).toHaveBeenCalledWith('h');
});
```

`apps/api/src/routes/auth/verifyEmail.test.ts` — the step-2 path:
```ts
it('a pending-registration token creates the partner with the STEP-1 attribution, not the click IP', async () => {
  vi.mocked(consumePendingRegistration).mockResolvedValueOnce({
    email: 'new@corp.com', companyName: 'Acme', name: 'A', passwordHash: 'hashed',
    acceptTerms: true, termsVersion: 'v1', hostedExpectation: true, createdAt: Date.now(),
    signupIp: '203.0.113.7', signupUserAgent: 'Mozilla/5.0 (signup)',
  });
  // The verification request itself arrives from a mail scanner:
  vi.mocked(getTrustedClientIpOrUndefined).mockReturnValue('198.51.100.9');
  const res = await postVerify({ token: 'raw' });
  expect(res.status).toBe(200);
  expect(vi.mocked(createPartner)).toHaveBeenCalledWith(expect.objectContaining({
    origin: { mcp: false, ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (signup)' },
  }));
});
it('a second click on the same token is a no-op (single-winner GETDEL)', async () => { /* second consume → null → generic 400 */ });
it('the address was registered while the link sat in the mailbox: directs the owner to sign in, creates nothing', async () => {
  // uniqueness re-check at step 2 -> { status: 'sign_in' }; createPartner NOT called.
});
```
**Guard-bite:** pass the click's IP into `createPartner` → test 1 RED.

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/pendingRegistration.test.ts src/routes/auth/register.test.ts src/jobs/authEmailWorker.test.ts src/routes/auth/verifyEmail.test.ts
```
Expected: FAIL — `/register-partner` still calls `createPartner` and mints tokens in-request.

- [ ] **Step 3: Implement `services/pendingRegistration.ts`** (shape given in Interfaces; copy the `getdel`-or-`eval` fallback verbatim from `routes/auth/password.ts:49-77` — the same Redis-client capability dance).

- [ ] **Step 4: Rewrite `/register-partner` step 1**

Keep, in order: the `ENABLE_REGISTRATION` gate, the `runWithSystemDbAccess` wrapper **only around the self-hosted setup-admin gate** (that gate DOES need a DB read; in hosted mode it is skipped entirely), the hosted-mode bypass audit, the Redis check, the rate limit, and `isPasswordStrong`. Then:

```ts
    const passwordHash = await hashPassword(password);

    // SR2-21: NO user-existence lookup. That lookup was the oracle — the
    // handler branched on it (`existingUser.length > 0` → early generic 200)
    // and the branch was ~1 DB round-trip cheaper than the branch that ran
    // createPartner, so the response TIME told an attacker whether the address
    // had an account even though the response BODY did not. We now do the
    // identical work for every input and let the WORKER (which the requester
    // cannot observe) decide what to send.
    //
    // The record carries the step-1 abuse attribution (#2343). Step 2 passes
    // THESE values to createPartner — never the verification click's IP/UA,
    // which is routinely a mail client or a link scanner in another country and
    // would poison the signup-abuse corpus.
    let tokenHash: string;
    try {
      const created = await createPendingRegistration({
        email: email.toLowerCase().trim(),
        companyName,
        name,
        passwordHash,
        acceptTerms,
        termsVersion: TERMS_VERSION,          // read the constant the current handler/schema uses
        hostedExpectation: isHosted(),
        signupIp: getTrustedClientIpOrUndefined(c),
        signupUserAgent: c.req.header('user-agent'),
      });
      tokenHash = created.tokenHash;
      // The raw token never leaves createPendingRegistration's caller boundary
      // except inside the verification EMAIL. It is not returned to the client,
      // not logged, and not audited.
      pendingRawToken = created.rawToken;
    } catch (err) {
      console.error('[register-partner] pending-registration write failed', err);
      captureException(err, c);
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }

    await enqueueRegistrationVerification(tokenHash);

    return c.json({
      success: true,
      message: 'If registration can proceed, you will receive next steps shortly.',
    });
```
The raw token must reach the **worker**, which only receives `tokenHash`. Resolve this by having `createPendingRegistration` store the raw token **inside** the Redis value (`{ …record, rawToken }`) so the worker can build the verification URL after `peekPendingRegistration`. That is safe: the Redis value is already the secret material's home, and the key is the hash. **Do not** put the raw token in the queue job (BullMQ job payloads are retained on completion/failure per `removeOnComplete`/`removeOnFail` and are readable from any Redis client with queue access).

- [ ] **Step 5: Implement the worker's `registration` case**

`peekPendingRegistration(tokenHash)` → if `null` (expired), return (no retry). Then, under `withSystemDbAccessContext`, look the address up in `users`:
- **no row** → `sendVerificationEmail({ to: rec.email, name: rec.name, verificationUrl })` where the URL is `${appBaseUrl}/auth/verify-email?token=${encodeURIComponent(rec.rawToken)}`.
- **row exists** → `sendSignupAttemptOnExistingAccount({ to: rec.email, name: <live user's name> })` — copy: "Someone tried to create a Breeze account with this address. You already have one — sign in, or reset your password if you've forgotten it." **Do not** send the signup link (it would dead-end anyway) and **do not** delete the pending record (let it expire by TTL; deleting it would create a Redis-visible timing difference between the branches). Q5 option (b).
Either branch: the requester sees the same 200 and the same latency, because both happen in the worker.

- [ ] **Step 6: Implement step 2 in `routes/auth/verifyEmail.ts`**

A submitted token is first tried as a **pending registration** (`consumePendingRegistration(sha256(token))`), then, on `null`, as an `email_verification_tokens` row (Task 8's `consumeVerificationToken`). On a pending-registration hit:
1. Re-check `ENABLE_REGISTRATION` and `isHosted()` against `rec.hostedExpectation` — a policy flip between step 1 and step 2 denies (fail closed, generic 400).
2. Re-check global uniqueness (`SELECT id FROM users WHERE email = rec.email`) under `withSystemDbAccessContext`. If taken → return `200 { verified: false, status: 'sign_in' }` and create nothing. This discloses "already registered" only to whoever **holds the token**, i.e. whoever controls that mailbox — which the design explicitly permits ("directs the owner to sign in without disclosing details to the original requester").
3. `createPartner({ orgName: rec.companyName, adminEmail: rec.email, adminName: rec.name, passwordHash: rec.passwordHash, origin: { mcp: false, ip: rec.signupIp, userAgent: rec.signupUserAgent }, status: rec.hostedExpectation ? 'pending' : 'active' })`.
4. Stamp `users.email_verified_at` + `partners.email_verified_at` (the address is proven by the click), then `dispatchHook('registration', …)` exactly as the old handler did, then mint the session (`mintRefreshTokenFamily` → `getUserEpochs` → `createTokenPair` → `bindRefreshJtiToFamily` → `setRefreshTokenCookie`) and return the shape the old `/register-partner` returned (`{ user, partner, tokens, mfaRequired: false, redirectUrl? }`) **plus `verified: true`**. This is the ONLY place a registration session is minted.
5. A `createPartner` failure after the record was consumed loses the pending registration. Mitigate: **consume the record LAST is not possible** (the consume is the single-winner lock). Instead, on a `createPartner` throw, **re-write the record back** under the same key with the remaining TTL (`SETEX`) and return the generic 500 so the user can click again. Note this in a comment; the re-write is best-effort.

- [ ] **Step 7: Run to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/pendingRegistration.test.ts src/routes/auth/register.test.ts src/routes/auth/verifyEmail.test.ts src/jobs/authEmailWorker.test.ts && pnpm typecheck
```
Expected: PASS. **`register.test.ts` mock hazard:** the handler now issues **zero** `db.select()` calls in hosted mode. The file's ordered Drizzle queue currently primes several. Re-prime the queue to match the new call count — do not delete the setup-gate tests (self-hosted mode still selects).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/pendingRegistration.ts apps/api/src/services/pendingRegistration.test.ts apps/api/src/routes/auth/register.ts apps/api/src/routes/auth/register.test.ts apps/api/src/routes/auth/verifyEmail.ts apps/api/src/routes/auth/verifyEmail.test.ts apps/api/src/jobs/authEmailWorker.ts apps/api/src/jobs/authEmailWorker.test.ts apps/api/src/services/email.ts
git commit -m "feat(auth): email-first partner registration — no tenant, no token, no existence lookup before verification (SR2-21)"
```

---

### Task 10: SR2-21 — web signup switches to "check your email"; e2e rewritten

**Files:**
- Modify: `apps/web/src/stores/auth.ts:831` (`apiRegisterPartner`)
- Modify: `apps/web/src/components/auth/PartnerRegisterPage.tsx`
- Modify: `apps/web/src/components/auth/PartnerRegisterPage.test.tsx`
- Modify: `apps/web/src/components/auth/VerifyEmailPage.tsx` (handle the registration-completion response: it now carries tokens)
- Modify: `apps/web/src/locales/{en,pt-BR,de-DE,es-419,fr-FR}/auth.json`
- Modify: `e2e-tests/live-signup/phases/apiSmoke.ts`, `e2e-tests/live-signup/phases/uiFlow.ts`

**Interfaces:**
- `apiRegisterPartner` returns `{ success: true; message: string }` — the `user` / `tokens` / `redirectUrl` fields are **gone**. Update its TypeScript return type; `pnpm typecheck` in `apps/web` will find every consumer.
- `PartnerRegisterPage` no longer calls `login(...)` and no longer navigates on success. It renders a **"Check your email"** panel — mirroring the existing `forgotPassword.success.*` pattern in `auth.json` (`title` + `description`), which is the precedent to copy.

- [ ] **Step 1: Write the failing test**

`apps/web/src/components/auth/PartnerRegisterPage.test.tsx`:
```tsx
it('SR2-21: a successful signup shows "check your email" and does NOT log the user in', async () => {
  mockApiRegisterPartner.mockResolvedValue({ success: true, message: 'If registration can proceed…' });
  render(<PartnerRegisterPage />);
  await submitValidForm();
  expect(await screen.findByTestId('register-check-email')).toBeInTheDocument();
  expect(mockLogin).not.toHaveBeenCalled();
  expect(mockNavigateTo).not.toHaveBeenCalled();
});

it('shows the same "check your email" panel for an address that already has an account', async () => {
  // Same server response — the UI must not branch on it either.
  mockApiRegisterPartner.mockResolvedValue({ success: true, message: 'If registration can proceed…' });
  render(<PartnerRegisterPage />);
  await submitValidForm();
  expect(await screen.findByTestId('register-check-email')).toBeInTheDocument();
});
```
Guard-bite: restore the `if (result.user && result.tokens) { login(...); navigateTo(...) }` branch → test 1 RED.

- [ ] **Step 2: Run to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/web && pnpm vitest run src/components/auth/PartnerRegisterPage.test.tsx
```
Expected: FAIL — no `register-check-email` element.

- [ ] **Step 3: Implement**

`PartnerRegisterPage.tsx` — replace lines 51-67 with:

```tsx
    if (!result.success) {
      setError(result.error);
      setLoading(false);
      return;
    }

    // SR2-21: registration no longer auto-logs-in. The server created NOTHING —
    // no partner, no user, no session — and deliberately returns the same body
    // whether or not the address already has an account. Render one terminal
    // "check your email" state; branching on anything the server said here
    // would rebuild the enumeration oracle in the client.
    setSubmitted(true);
    setLoading(false);
```
and render, when `submitted`:
```tsx
  if (submitted) {
    return (
      <div data-testid="register-check-email">
        <h1>{t('register.checkEmail.title')}</h1>
        <p>{t('register.checkEmail.description')}</p>
      </div>
    );
  }
```
Match the surrounding panel markup/classes of `ForgotPasswordPage.tsx`'s success state — read it and reuse its structure so this does not look bolted on.

Remove the now-dead `login` and `safeNext`/`navigateTo` usage from this component (keep the registration-gate redirect effect).

**i18n — ALL FIVE locales.** Add to `apps/web/src/locales/en/auth.json`:
```json
"register": {
  "checkEmail": {
    "title": "Check your email",
    "description": "If registration can proceed, we've sent a confirmation link to that address. Click it to finish creating your account."
  }
}
```
and the translated equivalents in `pt-BR`, `de-DE`, `es-419`, `fr-FR`. The `localeParity` test fails if any of the five is missing the key.

`apps/web/src/stores/auth.ts:831` — narrow the return type; the fetch stays.

`VerifyEmailPage.tsx` — when `POST /auth/verify-email` responds with `{ verified: true, tokens, user }` (the registration-completion shape from Task 9), call `login(user, tokens)` and navigate to the dashboard. When it responds `{ verified: false, status: 'sign_in' }`, render "This address already has an account — sign in" with a link to `/login`. Both need i18n keys in **all five** locales.

- [ ] **Step 4: Rewrite the live-signup e2e**

`e2e-tests/live-signup/phases/apiSmoke.ts` — the POST to `/auth/register-partner` must now assert `200 { success, message }` and **no `tokens`**. `e2e-tests/live-signup/phases/uiFlow.ts` — after submitting the form, assert the `register-check-email` testid (query by `data-testid` only, per `e2e-tests/README.md`), then fetch the verification link out of the test mailbox (read how the suite already retrieves the signup verification mail — it exists today because `/register-partner` already sent one) and drive the `/auth/verify-email` page to completion, asserting the dashboard loads afterwards.

- [ ] **Step 5: Run to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/web && pnpm vitest run src/components/auth src/stores && pnpm typecheck && pnpm astro check
```
Expected: PASS. (`astro check` is part of CI and catches i18n/type drift the unit run misses.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/auth apps/web/src/stores/auth.ts apps/web/src/locales e2e-tests/live-signup
git commit -m "feat(web): signup shows 'check your email' — no auto-login before verification (SR2-21)"
```

---

### Task 11: Real-DB integration + concurrency proofs

**Files:**
- Create: `apps/api/src/__tests__/integration/emailRecoveryRegistration.integration.test.ts`

**Interfaces:** consumes everything above against a **real** Postgres.

**Stand up a PRIVATE database.** The shared integration Postgres on `:5433` is routinely contaminated by other worktrees, and `docker-compose.test.yml` ships an **unsized tmpfs** that fabricates failures (SQLSTATE 53100 "no space left on device", spurious deadlocks). Do not use it.

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
docker rm -f pr4-pg 2>/dev/null || true
docker run -d --name pr4-pg \
  -e POSTGRES_USER=breeze -e POSTGRES_PASSWORD=breeze -e POSTGRES_DB=breeze \
  -p 5455:5432 \
  --tmpfs /var/lib/postgresql/data:rw,size=2g \
  postgres:16-alpine
# wait for readiness
until docker exec pr4-pg pg_isready -U breeze >/dev/null 2>&1; do sleep 1; done
export DATABASE_URL="postgresql://breeze:breeze@localhost:5455/breeze"
```
The integration harness (`src/__tests__/integration/setup.ts`) runs `autoMigrate()` against `DATABASE_URL`, so the new migration applies automatically. The RLS role (`breeze_app`) is created by the baseline migration — confirm with `docker exec pr4-pg psql -U breeze -d breeze -c '\du'` before asserting anything about RLS.

- [ ] **Step 1: Write the tests**

```ts
describe('SR2-17 pending email — real Postgres', () => {
  it('initiation writes pending_email and advances email_epoch, and users.email is UNCHANGED');
  it('commit swaps the address, clears pending, advances auth_epoch + email_epoch, and revokes every family — atomically');
  it('a commit that throws mid-transaction leaves NOTHING applied (no swap, no epoch bump, no revoked family)');
  it('CONCURRENCY: two users with the SAME pending_email — exactly one commit wins; the loser gets email_taken and its token is NOT left consumed');
  it('CONCURRENCY: two clicks on the same email_change token — exactly one wins');
  it('a stale link issued for the OLD address cannot verify the NEW one (email_epoch moved)');
  it('after commit, /auth/login with the OLD address fails and with the NEW address succeeds');
  it('a pending (unverified) address does NOT authenticate: users.email lookup returns no row for it');
});

describe('SR2-21 pending registration — real Postgres + real Redis', () => {
  it('step 1 creates NO rows in users, partners, organizations or sites');
  it('step 2 creates the tenant and stamps partners.signup_ip / user_agent with the STEP-1 values, not the click values');
  it('CONCURRENCY: two clicks on the same pending-registration token — exactly one partner is created');
  it('an address registered between step 1 and step 2 yields sign_in and creates no duplicate tenant');
});

describe('SR2-22 forgot-password — real Postgres', () => {
  it('the REQUEST advances no epoch and writes no reset key; the WORKER does both');
  it('an unknown address leaves password_reset_epoch untouched everywhere');
});

describe('SR2-23 login lockout — real Postgres', () => {
  it('a locked account and an unknown account return identical status AND body');
});
```
Read `apps/api/src/__tests__/integration/db-utils.ts` for the seeding helpers (`createSeededTenant`-style) and `ssoHardening.integration.test.ts` (shipped in #2492) for the app-bootstrap + `createTestToken` pattern — copy them, do not reinvent.

The **`email_taken` rollback question flagged in Task 8** is settled here: assert the losing token row still has `consumed_at IS NULL` after the 23505. If it does not, postgres.js aborted the outer transaction on the caught error and Task 8's implementation must move the swap into a savepoint (`tx.savepoint(...)`). **Fix Task 8's code, then re-run — do not weaken the assertion.**

- [ ] **Step 2: Run**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
export DATABASE_URL="postgresql://breeze:breeze@localhost:5455/breeze"
cd apps/api && pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/emailRecoveryRegistration.integration.test.ts
```
Expected: PASS (single-fork — the integration config already enforces it).

- [ ] **Step 3: Tear down and commit**

```bash
docker rm -f pr4-pg
git add apps/api/src/__tests__/integration/emailRecoveryRegistration.integration.test.ts
git commit -m "test(auth): real-DB atomicity + single-winner concurrency for pending email, registration, reset (SR2-17/21/22/23)"
```

---

### Task 12: Full-suite verification gate

**Files:** none (verification only).

- [ ] **Step 1: Typecheck + build (API and web)**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm typecheck && pnpm build
cd ../web && pnpm typecheck && pnpm astro check && pnpm build
```
Expected: no type errors, both builds succeed. (Type Check includes test files — the new suites must typecheck too.)

- [ ] **Step 2: Full API unit suite**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run
```
Expected: PASS. The API suite is flaky in parallel — if it is not already single-fork, re-run the failures serially before believing a red.

- [ ] **Step 3: Focused suites for everything this PR touched**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run \
  src/routes/auth src/routes/auth.test.ts src/routes/auth.passkeys.test.ts \
  src/routes/users.test.ts src/routes/sso.test.ts \
  src/middleware/cfAccessLogin.test.ts src/middleware/auth.test.ts \
  src/services/mfa.test.ts src/services/emailVerification.test.ts \
  src/services/pendingEmail.test.ts src/services/pendingRegistration.test.ts \
  src/services/authEmailQueue.test.ts src/jobs/authEmailWorker.test.ts \
  src/db/autoMigrate.test.ts
```
Expected: PASS.

- [ ] **Step 4: Web tests + locale parity + no-silent-mutations**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/web && pnpm vitest run
```
Expected: PASS — specifically the `localeParity` suite (all five locales carry every new key) and `no-silent-mutations` (allowlist count reconciled).

- [ ] **Step 5: Migration drift + ordering + idempotent re-apply**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && pnpm db:check-drift
psql "$DATABASE_URL" -f migrations/2026-07-18-pending-email-and-verification-purpose.sql
pnpm db:check-drift
pnpm vitest run src/db/autoMigrate.test.ts
```
Expected: **no drift** both times (the second run proves the migration re-applies as a true no-op); `autoMigrate.test.ts` PASSES.

- [ ] **Step 6: RLS suite**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run --config vitest.config.rls.ts
```
Expected: PASS with **no allowlist changes** — this PR adds no tables. If `rls-coverage.integration.test.ts` fails claiming an unregistered table, you added a table you were not supposed to. STOP and escalate.

- [ ] **Step 7: Real-DB integration**

Bring the private `pr4-pg` container back up (Task 11 Step 0 recipe) and run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
export DATABASE_URL="postgresql://breeze:breeze@localhost:5455/breeze"
cd apps/api && pnpm vitest run --config vitest.integration.config.ts
docker rm -f pr4-pg
```
Expected: PASS (the whole integration set, not just this PR's file — Tasks 5/7/9 changed handlers other integration suites drive).

- [ ] **Step 8: Open the PR**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
git push -u origin core-auth-4-email-recovery-registration
gh pr create --title "feat(auth): email, recovery, registration, and enumeration hardening (SR2-17, SR2-18, SR2-21..23)" --body "$(cat <<'EOF'
Implements PR 4 of the core-authentication hardening design (docs/superpowers/specs/security-auth/2026-07-11-core-authentication-hardening-design.md). Builds on PR 1 (#2378), PR 2 (#2385) and PR 3 (#2492).

## What
- **SR2-17 pending email:** changing an account email records `users.pending_email` and advances `email_epoch`; `users.email` does not move until a `purpose='email_change'` verification token proves control of the new address. The commit swaps atomically under `users_email_unique`, advances `auth_epoch` + `email_epoch`, and revokes every refresh family. CF Access and SSO match on `users.email` only — never the pending address (pinned by a contract test).
- **SR2-18 recovery-grade step-up:** an email change now requires current-password **and** a fresh existing-factor step-up grant; a user in the forced-enrollment state cannot move their recovery address at all.
- **SR2-21 email-first registration:** `/auth/register-partner` creates no partner, no user, no tokens, and performs **no user-existence lookup**. It stores a Redis pending record (with the step-1 abuse attribution from #2343) and returns one fixed generic body. Verification creates the tenant — with the **step-1** IP/UA, never the mail-scanner's.
- **SR2-22 async forgot-password:** the request does zero DB reads, zero epoch advances, zero email sends. A BullMQ worker resolves eligibility out of band.
- **SR2-23 lockout uniformity:** a locked account returns the byte-identical generic 401 an unknown email gets. The owner is still notified out of band.
- **PR 3 carry-forwards:** CF Access mint sites honour the effective MFA policy (no vacuous `mfa=true`); the dead non-consuming `verifyMFAToken` is deleted; the MFA step-up grant is consumed only *after* the factor proof validates (a wrong code no longer burns it).

## Behaviour changes operators should know
- Signup no longer auto-logs-in. New partners see "check your email".
- Changing your email signs you out **when you confirm the new address**, not when you request it.
- The login lockout still blocks — it just no longer announces itself.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR opens against `main`.

---

## Self-Review

**Spec coverage (PR 4 scope):**
- SR2-17 (pending email workflow, verified address authoritative for IdP matching, artifacts bound to user+address+epoch, atomic commit + uniqueness + sign-out, old-address notice at initiation) → Tasks 6, 7, 8, 11. ✓
- SR2-18 (recovery-address step-up; forced-enrollment exemption does not permit email mutation) → Task 7. ✓
- SR2-21 (email-first registration: no existence lookup, no tenant/token before verification, Redis pending record ≥256-bit token + 1h TTL, step-1 attribution into `createPartner`, generic response, web + e2e contract) → Tasks 9, 10, 11. ✓
- SR2-22 (forgot-password enqueues an opaque job, awaits no conditional DB/email work; the worker resolves eligibility) → Task 5, 11. ✓
- SR2-23 (locked accounts return the same generic floored response) → Task 4, 11. ✓
- Carry-forwards → Tasks 1 (dead `verifyMFAToken`), 2 (`cfAccessLogin` mfa parity), 3 (grant-consume ordering). ✓

**Already done by PRs 1–3 — do NOT re-implement:**
- `auth_epoch` / `mfa_epoch` / `email_epoch` / `password_reset_epoch` on `users`; `absolute_expires_at` on `refresh_token_families`; `aep`/`mep`/`sid` claims; the `/refresh` epoch gate (PR 1).
- `services/authLifecycle.ts` (`advanceUserEpochs`, `revokeAllRefreshFamilies`, `runPostCommitCleanup`) (PR 1).
- **SR2-08 password-reset generation binding** — the `{ userId, passwordResetEpoch, email }` reset envelope is **shipped** in `routes/auth/password.ts`. Task 5 only *moves* it into the worker; it does not redesign it.
- The `/login` timing floor (`LOGIN_RESPONSE_FLOOR_MS`, `loginResponseFloorPromise`) and the dummy-argon2 equalizer — shipped in PR 1. Task 4 reuses them.
- `email_verification_tokens.email_epoch` + the `address_changed` fail-closed check + `FOR UPDATE` on the users row (#2428, shipped). Task 8 extends this with a `purpose` branch rather than building it from scratch.
- The email-change `auth_epoch` bump + family revoke (#2428, shipped) — Task 7 **narrows** it to `email_epoch`-only at initiation and moves the rest to commit (see **Q2**).
- `services/mfaStepUpGrant.ts` + `enforceExistingFactorStepUp` two-phase `consume` flag (PR 2). Task 3 uses the flag that already exists; no signature change.
- `services/roleAssignment.ts`, `services/urlSafety.ts` `safeFetch` (PR 3) — not needed by PR 4; do not touch.
- `services/clientIp.ts` `getTrustedClientIpOrUndefined` — already in use at `register.ts:199`. PR 6 owns the *canonical resolver sweep*; Task 9 simply keeps using the existing helper.

**Placeholder scan:** every code step contains concrete code. Test steps that say "read the file for the real fixture name" name the exact file and the exact assertions required — unavoidable, because the hand-rolled ordered Drizzle mocks must match the specific source chain and cannot be written blind. No TBD/TODO/"add appropriate error handling"/"similar to Task N".

**Type consistency:** `AuthEmailJob` (Task 5) is consumed unchanged by Task 9's `registration` case. `PendingRegistration` (Task 9) is produced by `createPendingRegistration`, read by `peekPendingRegistration` (worker) and `consumePendingRegistration` (verify route). `requestPendingEmailChange` returns `{ rawToken, emailEpoch }` (Task 7) and is called only from `PATCH /users/me`. `generateVerificationToken`'s new `purpose` param (Task 7 declares it optional; Task 8 branches on it) and `ConsumeResult`'s new `purpose`/`previousEmail`/`email_taken`/`no_pending_email` members are used identically in Tasks 8, 9, 11. `sendEmailChanged({ pending })` is called with `pending: true` at initiation (Task 7) and `pending: false` at commit (Task 8). ✓

**Fail-closed audit:** every gate added here denies on absence — a null epoch read (Task 2, 7), a 0-row `UPDATE … RETURNING` (Task 7), a missing/unreadable Redis record (Tasks 5, 9), an unresolvable MFA policy (Task 7), a NULL token epoch on an `email_change` row (Task 8), a 23505 at swap time (Task 8). None of them treats "no rows" as "no constraint".
