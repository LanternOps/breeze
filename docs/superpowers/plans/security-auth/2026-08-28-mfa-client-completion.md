# MFA Client Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete issue #2489 by making MFA challenges policy-safe and method-aware across the API, web, and mobile clients, while adding policy-driven forced enrollment and fail-closed mobile behavior for enrollment-required responses.

**Architecture:** The API computes one authoritative challenge contract from enrolled factors and the live effective MFA policy, stores the same authorization facts in a strictly parsed pending record, and rechecks enrollment, policy, epochs, and account state at every continuation. Web and mobile adapters normalize that contract before rendering client-specific method selectors. Initial factor enrollment finishes through a shared transactional service that advances `mfa_epoch`, revokes old refresh families, persists the factor and recovery codes, and issues a replacement W07 session atomically.

**Tech Stack:** Hono, TypeScript, Drizzle ORM, PostgreSQL transactions/row locks, Redis pending challenges, Vitest, Astro/React, React Native/Expo, Redux Toolkit.

## Global Constraints

- The approved design at `docs/superpowers/specs/security-auth/2026-08-28-mfa-client-completion-design.md` is normative.
- Scope is #2489, #3853, and the client-completion portion of #3854. W07 native-binding transport remains deferred, so #3854 stays open after Slice 4.
- Do not deploy, push, merge, enable `AUTH_BROWSER_TRANSITIONS_ENFORCED`, or add another rollout flag. The only protocol marker in scope is `x-breeze-auth-transition: v1`.
- Preserve the W07 capability boundary: only `issueUserSession` may mint the replacement session, and issuance must finish under `finishAuthIssuance` with the request binding.
- Global lock order remains transition, user, refresh families, then factor-specific rows. No network call, WebAuthn verification, SMS send, or password/TOTP computation may run while a database transaction or row lock is held.
- Every method continuation independently authorizes the pending challenge, requested method, actual enrollment, live policy, current account status, `auth_epoch`, and `mfa_epoch`. A live-policy or epoch mismatch is terminal and deletes the pending challenge.
- Pending-record booleans are strict. Records missing `allowedMethods` or `recoveryAvailable`, or containing non-boolean values, are rejected rather than defaulted. Existing records may therefore fail closed for at most the current 300-second TTL.
- Recovery-code consumption moves inside guarded finalization only for the v1 pending-record path. Preserve the legacy path until W07 Phase 2.
- `passkey` is included in the shared `MfaMethod` type, but native mobile challenge completion supports only TOTP, SMS, and recovery in this work.
- Recovery codes are returned only after a factor is successfully enabled. A partial setup, canceled registration, failed confirmation, or rolled-back transaction must not create or expose recovery codes.
- `commitIfCurrent` ordering is mandatory on mobile: advance the generation before logout/account switch, then guard every asynchronous challenge or enrollment result before changing credentials or navigation state.
- Strict TDD applies to each slice: observe each focused test fail for the intended reason, implement the smallest coherent change, pass the focused suite, then commit the slice.

---

## File and Interface Map

### New files

- `apps/api/src/services/mfaEnrollmentSession.ts` — atomic initial-factor persistence, recovery-code persistence, assurance invalidation, refresh-family revocation, and replacement W07 session issuance.
- `apps/api/src/services/mfaEnrollmentSession.test.ts` — transaction order, rollback, and result-contract unit tests.
- `apps/api/src/__tests__/integration/mfaEnrollmentSession.integration.test.ts` — real-database rollback and concurrent-completion barriers.
- `apps/web/src/lib/mfaChallenge.ts` — strict compatibility adapter for new and legacy login responses.
- `apps/web/src/lib/mfaChallenge.test.ts` — new-contract, legacy fallback, and malformed-response tests.
- `apps/web/src/components/auth/MFAVerifyForm.test.tsx` — selector, input-mode, SMS-send, recovery, and passkey behavior.
- `apps/web/src/components/auth/ForcedMfaSetupPage.test.tsx` — policy-driven enrollment choices and terminal-session response handling.
- `apps/mobile/src/screens/auth/MfaEnrollmentRequiredScreen.tsx` — actionable web/admin handoff without installing returned credentials.
- `apps/mobile/src/screens/auth/MfaEnrollmentRequiredScreen.test.tsx` — fail-closed rendering and navigation tests.
- `apps/mobile/src/screens/auth/MfaChallengeScreen.test.tsx` — native method selection, input, SMS-send, and stale-completion tests.

### Existing files with central changes

- `apps/api/src/routes/auth/{helpers,helpers.test,login,login.test,mfa}.ts`
- `apps/api/src/routes/auth/{phone,phone.test,passkeys}.ts`
- `apps/api/src/routes/auth.passkeys.test.ts`
- `apps/api/src/routes/auth/index.ts`
- `apps/api/src/routes/auth/schemas.ts`
- `apps/api/src/routes/auth.test.ts`
- `apps/api/src/services/{mfaAssurance,mfaAssurance.test,userSession}.ts`
- `apps/api/src/middleware/{auth,auth.test}.ts`
- `apps/web/src/stores/{auth,auth.test}.ts`
- `apps/web/src/components/auth/{LoginPage,LoginPage.test,LoginPage.passkeys.test,MFAVerifyForm,ForcedMfaSetupPage}.tsx`
- `apps/mobile/src/services/{api,api.mfa.test}.ts`
- `apps/mobile/src/store/{authSlice,authSlice.test}.ts`
- `apps/mobile/src/navigation/RootNavigator.tsx`
- `docs/testing/FEATURE_TEST_LOG.md`

### Stable challenge interfaces

```ts
export type MfaMethod = 'totp' | 'sms' | 'passkey' | 'recovery';

export interface MfaAllowedMethods {
  totp: boolean;
  sms: boolean;
  passkey: boolean;
}

export interface MfaRequiredResponse {
  mfaRequired: true;
  tempToken: string;
  mfaMethod: Exclude<MfaMethod, 'recovery'>;
  allowedMethods: MfaAllowedMethods;
  recoveryAvailable: boolean;
  passkeyAvailable: boolean;
  phoneLast4: string | null;
  user: null;
  tokens: null;
}

export interface PendingMfaRecord {
  userId: string;
  mfaMethod: Exclude<MfaMethod, 'recovery'>;
  allowedMethods: MfaAllowedMethods;
  recoveryAvailable: boolean;
  authEpoch: number;
  mfaEpoch: number;
  transitionId: string;
  transitionGeneration: number;
  expiresAt: number;
  pendingSsoLink?: PendingSsoLink;
}
```

`passkeyAvailable` remains in the response as a compatibility alias for `allowedMethods.passkey`. New clients treat `allowedMethods` and `recoveryAvailable` as authoritative. Legacy clients fall back only when both new fields are absent and the legacy fields are well formed.

### Atomic enrollment-session interface

```ts
export interface CompleteInitialMfaEnrollmentInput<T> {
  userId: string;
  identity: UserSessionIdentity;
  capability: AuthIssuanceCapability;
  expectedAuthEpoch: number;
  expectedMfaEpoch: number;
  revokeReason: string;
  recoveryCodes: readonly string[];
  recoveryCodeHashes: readonly string[];
  persistFactor: (tx: Tx, recoveryCodeHashes: readonly string[]) => Promise<T>;
}

export interface CompletedInitialMfaEnrollment<T> {
  value: T;
  recoveryCodes: string[];
  issued: AuthorizedUserSession;
  mfaEpoch: number;
  cleanup: MfaAssuranceCleanup;
}

export async function completeInitialMfaEnrollment<T>(
  input: CompleteInitialMfaEnrollmentInput<T>,
): Promise<CompletedInitialMfaEnrollment<T>>;
```

Generate and hash recovery codes before beginning guarded finalization; do not expose them unless finalization commits. Implementation order inside `finishAuthIssuance(capability, tx => ...)` is: conditionally advance `mfa_epoch` while locking the active, still-unenrolled user at both `expectedAuthEpoch` and `expectedMfaEpoch`, revoke all existing refresh families, issue the replacement family/session with the new epochs, then call `persistFactor` with the precomputed hashes. The conditional epoch write makes concurrent terminal enrollments single-winner and prevents a request authenticated before a password/reset/logout cutoff from laundering stale authority into the newer auth epoch. The transaction rollback removes the new family, factor, recovery hashes, epoch change, and revocations together. After commit, routes bind the issued session, install refresh/CSRF cookies, run best-effort Redis/remote-session cleanup, and return public access metadata plus the precomputed plaintext recovery codes.

---

## Slice 1: API Challenge Contract and Independent Authorization

**Outcome:** Login returns an authoritative method set, all continuations reauthorize that method, forced enrollment exposes live options, and every terminal enrollment replaces the session atomically.

### Task 1.1: Freeze the strict pending-record and response contract

**Files:**
- Modify: `apps/api/src/routes/auth/helpers.ts`
- Modify: `apps/api/src/routes/auth/helpers.test.ts`
- Modify: `apps/api/src/routes/auth/schemas.ts`

- [ ] Add table-driven red tests for a valid v1 record; each missing boolean; string/number/null booleans; invalid `mfaMethod`; invalid epochs; expired records; and a well-formed optional SSO link.
- [ ] Add schema tests proving `/auth/mfa/verify` accepts exactly `totp`, `sms`, or `recovery`, while passkey remains on its dedicated continuation.
- [ ] Implement structural validation without truthy/falsy defaults. Return `null` for every malformed or expired record.
- [ ] Run:

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/auth/helpers.test.ts src/routes/auth/auth.test.ts --maxWorkers=1 --no-file-parallelism
```

### Task 1.2: Derive and persist the authoritative login challenge

**Files:**
- Modify: `apps/api/src/routes/auth/login.ts`
- Modify: `apps/api/src/routes/auth/login.test.ts`

- [ ] Add the full derivation matrix for enrolled TOTP, enrolled/configured SMS, registered passkey, recovery hashes, and effective live policy.
- [ ] Assert legacy `mfaMethod` selection is deterministic: retain the configured primary when allowed; otherwise use TOTP, then SMS, then passkey; never emit `recovery` as the primary.
- [ ] Assert no usable primary or recovery method returns the existing generic authentication failure, writes no pending record, and leaks no enrollment/policy detail.
- [ ] Assert the Redis record and HTTP response contain the same `allowedMethods` and `recoveryAvailable` values, with `user: null` and `tokens: null`.
- [ ] Implement one pure helper near the login handler:

```ts
function deriveMfaChallenge(input: {
  enrolled: { totp: boolean; sms: boolean; passkey: boolean };
  recoveryAvailable: boolean;
  allowedByPolicy: MfaAllowedMethods;
  preferred: Exclude<MfaMethod, 'recovery'>;
}): { allowedMethods: MfaAllowedMethods; recoveryAvailable: boolean; primary: Exclude<MfaMethod, 'recovery'> } | null;
```

- [ ] Run the focused login suite and confirm both the old legacy response assertions and new matrix pass.

### Task 1.3: Enforce the normative method-switch algorithm

**Files:**
- Modify: `apps/api/src/routes/auth/mfa.ts`
- Modify: `apps/api/src/routes/auth.test.ts`

- [ ] Add the method-switch matrix: pending-primary default, allowed TOTP switch, allowed SMS switch, authorized recovery switch, disallowed switch, missing enrollment, live-policy drift, epoch drift, disabled/locked user, malformed pending record, and replay after terminal failure.
- [ ] Add a deterministic recovery concurrency test proving one code can finalize one session only; keep the existing legacy-path consumption assertion unchanged.
- [ ] Implement selection and authorization in this exact order:

```ts
const requestedMethod = body.method ?? pending.mfaMethod;
if (requestedMethod === 'recovery') authorizePendingRecovery(pending);
else authorizePendingMethod(pending, requestedMethod, liveUser, livePolicy);
```

- [ ] Delete the pending record on policy/epoch/status terminal failures. Preserve it for a wrong TOTP/SMS/recovery value subject to current attempt/rate limits.
- [ ] Move v1 recovery consumption into the guarded finalization transaction so rollback or a lost transition race does not burn a code.
- [ ] Run `auth.test.ts` alone until the complete matrix passes.

### Task 1.4: Independently authorize SMS and passkey continuations

**Files:**
- Modify: `apps/api/src/routes/auth/phone.ts`
- Modify: `apps/api/src/routes/auth/phone.test.ts`
- Modify: `apps/api/src/routes/auth/passkeys.ts`
- Modify: `apps/api/src/routes/auth.passkeys.test.ts`

- [ ] For `/auth/mfa/sms/send`, add red tests for malformed pending data, SMS not authorized, SMS not enrolled/configured, policy drift, epoch drift, disabled/locked account, exhausted rate limit, and a valid method switch from TOTP.
- [ ] Assert no SMS provider call happens until every pending/live check and rate limit passes.
- [ ] For `/auth/mfa/passkey/options` and `/auth/mfa/passkey/verify`, add the same authorization cases plus a valid switch from another primary and terminal pending deletion on drift.
- [ ] Replace `mfaMethod === 'passkey' || passkeyAvailable` with `allowedMethods.passkey` and live enrollment/policy checks on both routes.
- [ ] Keep WebAuthn option generation and assertion verification outside the guarded database transaction.
- [ ] Run:

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/auth/phone.test.ts src/routes/auth/auth.passkeys.test.ts --maxWorkers=1 --no-file-parallelism
```

### Task 1.5: Add forced-enrollment options and atomic terminal enrollment

**Files:**
- Create: `apps/api/src/services/mfaEnrollmentSession.ts`
- Create: `apps/api/src/services/mfaEnrollmentSession.test.ts`
- Create: `apps/api/src/__tests__/integration/mfaEnrollmentSession.integration.test.ts`
- Modify: `apps/api/src/services/mfaAssurance.ts`
- Modify: `apps/api/src/services/mfaAssurance.test.ts`
- Modify: `apps/api/src/routes/auth/mfa.ts`
- Modify: `apps/api/src/routes/auth/phone.ts`
- Modify: `apps/api/src/routes/auth/passkeys.ts`
- Modify: `apps/api/src/routes/auth/index.ts`
- Modify: `apps/api/src/middleware/auth.test.ts`
- Modify the same route test files from Tasks 1.3 and 1.4.

- [ ] Add `GET /auth/mfa/enrollment-options`, authenticated and current-user scoped, returning `{ allowedMethods, phoneConfigured }` from the effective policy. Passkey is always allowed by current policy behavior.
- [ ] Prove the route is reachable while the normal authenticated surface is returning the 428 enrollment gate; retain existing `/auth/mfa/*`, `/auth/phone/*`, and `/auth/passkeys/*` exemptions.
- [ ] Add service unit tests for success, factor-write failure, session-issuance failure, epoch mismatch, mismatched plaintext/hash counts, and cleanup metadata. Assert all authority-bearing writes share one supplied transaction and recovery-code generation/hashing finishes before it starts.
- [ ] Add real-DB integration tests with deterministic barriers for two simultaneous terminal completions. Exactly one replacement session/factor commit may win; no test may use sleeps for ordering.
- [ ] Add route tests proving TOTP setup does not return recovery codes; successful TOTP enable, SMS enable, and first passkey registration each return recovery codes and a replacement access session while installing refresh/CSRF cookies.
- [ ] Add rollback tests proving none of factor state, recovery hashes, `mfa_epoch`, old-family revocations, or the new family commits alone.
- [ ] Refactor the existing invalidation primitive only enough to share epoch/revocation/cleanup logic; existing non-enrollment factor changes keep their current behavior.
- [ ] Bind the issued session and install cookies only after transaction commit. If post-commit Redis/remote cleanup fails, preserve the committed session and log/metric the cleanup failure.
- [ ] Run:

```bash
pnpm --filter=@breeze/api exec vitest run src/services/mfaEnrollmentSession.test.ts src/services/mfaAssurance.test.ts src/routes/auth/helpers.test.ts src/routes/auth/login.test.ts src/routes/auth/auth.test.ts src/routes/auth/phone.test.ts src/routes/auth/auth.passkeys.test.ts src/middleware/auth.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/mfaEnrollmentSession.integration.test.ts --maxWorkers=1 --no-file-parallelism
```

- [ ] Commit Slice 1:

```bash
git add apps/api
git commit -m "feat(auth): enforce MFA challenge contract (#3853)"
```

---

## Slice 2: Web Login Method Completion

**Outcome:** The browser renders every authorized challenge method, uses method-correct input behavior, and fails closed on malformed new responses while remaining compatible with old servers.

### Task 2.1: Build the web compatibility adapter

**Files:**
- Create: `apps/web/src/lib/mfaChallenge.ts`
- Create: `apps/web/src/lib/mfaChallenge.test.ts`
- Modify: `apps/web/src/stores/auth.ts`
- Modify: `apps/web/src/stores/auth.test.ts`

- [ ] Add red tests for a valid new response, each allowed-method combination, recovery-only availability, legacy TOTP/SMS/passkey responses, malformed/empty new fields, `mfaMethod: 'recovery'`, and inconsistent passkey aliases.
- [ ] Implement `parseMfaChallengeResponse(value): MfaChallenge | null`. Use the legacy fallback only when both `allowedMethods` and `recoveryAvailable` are absent; reject partially present new contracts.
- [ ] Extend `apiVerifyMFA` to send `{ code, method }` for TOTP/SMS/recovery. Keep passkey on the existing options/verify calls.
- [ ] Return a typed authentication error for malformed challenge data so LoginPage cannot enter an unusable MFA state.
- [ ] Run the adapter and auth-store suites.

### Task 2.2: Render the selector and method-correct controls

**Files:**
- Modify: `apps/web/src/components/auth/MFAVerifyForm.tsx`
- Create: `apps/web/src/components/auth/MFAVerifyForm.test.tsx`
- Modify: `apps/web/src/components/auth/LoginPage.tsx`
- Modify: `apps/web/src/components/auth/LoginPage.test.tsx`
- Modify: `apps/web/src/components/auth/LoginPage.passkeys.test.tsx`

- [ ] Add component tests proving the selector is hidden for one method and shown for two or more, including recovery as a selectable method.
- [ ] Assert TOTP and SMS accept exactly six numeric digits; recovery accepts text, trims only outer whitespace, and preserves internal separators; passkey renders its existing continuation.
- [ ] Assert selecting SMS sends once, does not double-send on rerender, observes the cooldown, and surfaces send failure without silently switching methods.
- [ ] Assert selecting passkey does not post to `/mfa/verify`; selecting recovery sends the normalized recovery code and explicit method.
- [ ] Store the full normalized challenge in `LoginPage`, initialize selection from its primary, and clear challenge state on cancel, successful completion, or a terminal server response.
- [ ] Preserve existing loading, toast, and passkey-browser fallback behavior.
- [ ] Run:

```bash
pnpm --filter=@breeze/web exec vitest run src/lib/mfaChallenge.test.ts src/stores/auth.test.ts src/components/auth/MFAVerifyForm.test.tsx src/components/auth/LoginPage.test.tsx src/components/auth/LoginPage.passkeys.test.tsx
```

- [ ] Commit Slice 2:

```bash
git add apps/web
git commit -m "feat(web): complete MFA login methods (#3853)"
```

---

## Slice 3: Web Forced Enrollment Completion

**Outcome:** The browser offers only policy-permitted initial factors, completes one factor at a time, and adopts the API-issued replacement session only after terminal success.

### Task 3.1: Add enrollment option API bindings

**Files:**
- Modify: `apps/web/src/stores/auth.ts`
- Modify: `apps/web/src/stores/auth.test.ts`

- [ ] Add red tests for `apiGetMfaEnrollmentOptions`, TOTP enable, SMS enable, and passkey register responses carrying replacement access metadata and recovery codes.
- [ ] Type the enrollment response separately from ordinary profile factor changes so callers must handle replacement-session metadata.
- [ ] Reuse the normal cookie-backed session installation path; do not call `/auth/refresh` after enrollment.

### Task 3.2: Make ForcedMfaSetupPage policy-driven

**Files:**
- Modify: `apps/web/src/components/auth/ForcedMfaSetupPage.tsx`
- Create: `apps/web/src/components/auth/ForcedMfaSetupPage.test.tsx`

- [ ] Add tests for TOTP-only, SMS configured, SMS missing phone, passkey-only, multiple methods, option-load failure, no usable method, canceled setup, failed terminal enable, and successful completion for each factor.
- [ ] Fetch enrollment options on entry. Recovery is never an enrollment choice; SMS is enabled only when both policy and `phoneConfigured` permit it.
- [ ] Reuse current TOTP setup/enable, phone verify/SMS enable, and passkey registration operations rather than creating parallel factor logic.
- [ ] Keep recovery codes hidden until the terminal endpoint succeeds; show the returned set once and require the existing acknowledgement behavior before leaving.
- [ ] Adopt the response access metadata only through the auth store’s current-session guard, then navigate to the originally gated destination. On failure, remain in enrollment and retain no partial client session.
- [ ] Fail closed with support/admin guidance if options cannot load or no method is usable.
- [ ] Run:

```bash
pnpm --filter=@breeze/web exec vitest run src/stores/auth.test.ts src/components/auth/ForcedMfaSetupPage.test.tsx
```

- [ ] Commit Slice 3:

```bash
git add apps/web
git commit -m "feat(web): add policy-driven MFA enrollment (#3853)"
```

---

## Slice 4: Mobile Challenge Completion and Enrollment Fail-Closed

**Outcome:** Native login supports TOTP, SMS, and recovery method switching, never exposes an unsupported passkey-only dead end as a code form, and never installs credentials from an enrollment-required response.

### Task 4.1: Normalize mobile authentication responses

**Files:**
- Modify: `apps/mobile/src/services/api.ts`
- Modify: `apps/mobile/src/services/api.mfa.test.ts`

- [ ] Add `MfaMethod`, `MfaAllowedMethods`, and the same strict new/legacy adapter rules as web; share semantics, not a cross-package runtime import.
- [ ] Expand `LoginResult` into explicit success, challenge, and enrollment-required variants. The enrollment-required variant contains only display/handoff information, never installable tokens or a user.
- [ ] Add tests for new challenge combinations, recovery availability, legacy fallback, malformed fields, passkey-only challenge, and 428/`mfaEnrollmentRequired` bodies that contain tempting token-shaped fields.
- [ ] Change `verifyMfa` to accept an explicit TOTP/SMS/recovery method and preserve internal recovery separators.
- [ ] Do not change W07 native-binding header generation or transport in this slice.

### Task 4.2: Fence Redux challenge and enrollment state

**Files:**
- Modify: `apps/mobile/src/store/authSlice.ts`
- Modify: `apps/mobile/src/store/authSlice.test.ts`

- [ ] Add red tests proving login stores a normalized challenge but no credentials, verification commits only for the current generation, logout/account switch invalidates an in-flight result, and enrollment-required discards every returned token/user field.
- [ ] Add explicit `mfaEnrollmentRequired` state containing a safe handoff reason/URL and clear it on a new login, logout, account switch, or successful current-generation authentication.
- [ ] Advance the session generation before clearing credentials on logout/account switch. Route every async login/MFA completion through `commitIfCurrent` before mutating SecureStore or Redux state.
- [ ] Preserve the challenge on a retryable wrong code; clear it on terminal policy/epoch/status failure.

### Task 4.3: Add the native selector and handoff screen

**Files:**
- Modify: `apps/mobile/src/screens/auth/MfaChallengeScreen.tsx`
- Create: `apps/mobile/src/screens/auth/MfaChallengeScreen.test.tsx`
- Create: `apps/mobile/src/screens/auth/MfaEnrollmentRequiredScreen.tsx`
- Create: `apps/mobile/src/screens/auth/MfaEnrollmentRequiredScreen.test.tsx`
- Modify: `apps/mobile/src/navigation/RootNavigator.tsx`

- [ ] Add selector tests for one vs multiple supported methods, TOTP/SMS numeric input, recovery text input, SMS one-send/cooldown behavior, and stale result suppression after navigation/account change.
- [ ] Filter passkey out of native-selectable methods. If passkey is the only primary and no recovery method is available, show an upgrade/restart-on-web message instead of a numeric form.
- [ ] Render `MfaEnrollmentRequiredScreen` before every authenticated navigator branch. Provide an explicit open-web/sign-out/admin-contact path, with no route into the app shell.
- [ ] Assert the approver-registration effect and other authenticated startup effects do not run while enrollment is required.
- [ ] Run:

```bash
pnpm --filter=breeze-mobile exec vitest run src/services/api.mfa.test.ts src/store/authSlice.test.ts src/screens/auth/MfaChallengeScreen.test.tsx src/screens/auth/MfaEnrollmentRequiredScreen.test.tsx
pnpm --filter=breeze-mobile typecheck
```

- [ ] Commit Slice 4:

```bash
git add apps/mobile
git commit -m "feat(mobile): complete MFA challenge handling (#3854)"
```

---

## Slice 5: Consolidated Security Review and Verification

**Outcome:** One independent review validates the full cross-client implementation, all findings are fixed with targeted tests, and the feature log records evidence without deploying or closing #3854.

### Task 5.1: Run focused and package verification

- [ ] Run the complete focused suites from Slices 1–4 again from a clean worktree.
- [ ] Run package-level checks:

```bash
pnpm --filter=@breeze/api test:run
pnpm --filter=@breeze/api lint
pnpm --filter=@breeze/api build
pnpm --filter=@breeze/web exec vitest run
pnpm --filter=@breeze/web lint
pnpm --filter=@breeze/web build
pnpm --filter=breeze-mobile test
pnpm --filter=breeze-mobile typecheck
```

- [ ] Run the integration test with the repository test database. If the database is unavailable, record the exact infrastructure failure and do not describe integration coverage as passing.
- [ ] Run `git diff --check` and inspect `git status --short` for untracked fixtures, snapshots, secrets, or unrelated user changes.

### Task 5.2: Dispatch one independent review

- [ ] Provide the reviewer the approved spec, this plan, the full branch diff from `origin/main`, and these mandatory review questions:
  - Can any pending-record field, method switch, or continuation bypass live policy or enrollment?
  - Can recovery codes be consumed without a committed session, or exposed before committed enrollment?
  - Can factor state, epochs, family revocation, or replacement issuance commit partially or violate the W07 lock order?
  - Can either client install stale or enrollment-gated credentials?
  - Did this work add native W07 transport or any deploy/flag behavior outside scope?
- [ ] Fix every confirmed finding with a reproducing test, then rerun the affected focused suite. Request a second review only if the fix itself changes high-blast auth/session behavior or the user requests high rigor.

### Task 5.3: Record evidence and hand off issues accurately

**Files:**
- Modify: `docs/testing/FEATURE_TEST_LOG.md`

- [ ] Record exact commands, dates, pass/fail counts, and any unavailable integration dependency.
- [ ] Confirm #3853 is fully satisfied before using `Closes #3853` in a later PR. Use `Refs #3854` and state that MFA mobile client completion shipped while W07 native-binding transport remains open.
- [ ] Confirm the branch contains no deployment, flag enablement, release, or issue-close mutation.
- [ ] Commit Slice 5:

```bash
git add docs/testing/FEATURE_TEST_LOG.md apps/api apps/web apps/mobile
git commit -m "test(auth): verify MFA client completion (#2489)"
```

---

## Completion Checklist

- [ ] Every normative API method-switch combination has a focused test.
- [ ] Login response and pending record carry identical strict authorization facts.
- [ ] SMS and passkey continuations independently reauthorize pending state and live state.
- [ ] TOTP, SMS, and first-passkey enrollment atomically replace the old session and return recovery codes only after success.
- [ ] Web supports TOTP, SMS, passkey, and recovery login plus policy-driven forced enrollment.
- [ ] Mobile supports TOTP, SMS, and recovery, handles passkey-only safely, and fails closed on enrollment-required responses.
- [ ] Mobile W07 native-binding transport remains untouched and #3854 remains open.
- [ ] One independent review is clean or all confirmed findings have reproducing tests and verified fixes.
- [ ] Focused, package, integration, lint, build, typecheck, and diff checks have recorded evidence.
- [ ] Nothing was pushed, merged, deployed, or enabled.
