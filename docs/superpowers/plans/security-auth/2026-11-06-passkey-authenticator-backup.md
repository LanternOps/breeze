---
anchor_issue: 10650
related: [10650, 2153, 10671, 5038, 4934, 4018, 4045, 7369]
baseline_commit: bef484ca8b
spec: none (track:plan; design is inline below, sections "Design" and "Decisions")
status: approved
tracking_issue: 11420
---

# Authenticator App as a Backup Factor for Passkey-Primary Accounts: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This touches auth, so full rigor applies (red-first tests, one independent review round, integration suite on `pnpm test-stack`).

**Goal:** A user whose primary MFA method is a passkey can add an authenticator app (TOTP) as a backup second factor, use it to sign in when the passkey is unavailable, use it to repair their passkeys afterwards, and remove it again. The passkey stays primary throughout.

**Credit:** requested by community contributor Jonathan Pitre in #10650, with a precise write-up of the asymmetry against #2153. Accepted by the owner in the issue thread.

**Architecture:** No migration and no new column. `users.mfa_method` keeps meaning "primary factor". TOTP is enrolled when a shared predicate says so (`mfa_secret IS NOT NULL` and `mfa_method` is `totp` or `passkey`). It is a backup when the primary is `passkey`. The existing #5038 primitive `completeAdditionalMfaFactorEnrollment` performs the write. It bumps `mfa_epoch`, revokes every refresh family, and hands the caller a replacement session. It leaves recovery codes alone. That is the mirror image of what passkey registration already does for TOTP-primary accounts (#2153). A new `POST /auth/mfa/totp/remove` removes the authenticator app on its own. `/mfa/disable` stops being able to switch MFA off while passkeys survive.

**Tech stack:** Hono + Drizzle (`apps/api/src/routes/auth/*`), Redis step-up grants (`services/mfaStepUpGrant.ts`), Astro + React (`apps/web/src/components/settings/*`), Vitest (unit, contract, integration on real Postgres + Redis).

## Waves

| Wave | Title | Migration | Tier | Merged first |
|---|---|---|---|---|
| W01 | API: factor predicate and invariants, backup enrolment, `/mfa/totp/remove`, `/mfa/disable` guard, contracts | no | Opus (T6 Sonnet) | none |
| W02 | Web + docs: backup row, remove flow, TOTP alternative in step-up prompts, login/mobile test locks, 8 locales | no | Opus (T5, T6 Sonnet) | W01 |

**Value checkpoint:** W01 alone makes the API correct and closes the stranded-state paths. A passkey-primary user cannot reach the feature until W02 ships the UI. Between the two waves, a TOTP-primary user who also holds passkeys and presses **Disable** gets an explanatory 409 instead of a silent downgrade (see W01 T4).

## Execution split and parallelism

Each wave branches from fresh `origin/main` as `feature/<parent#>-passkey-authenticator-backup/wave-<subissue#>` and targets `main`. Never stack: a stacked PR (base ≠ main) runs no CI, so a green-looking `gh pr checks` there means only the smoke workflows ran. W02 waits for W01 to merge, then rebases.

| Wave | PARALLEL GROUPS (file-disjoint, run in order) | API/web seam |
|---|---|---|
| W01 | {T1} → {T2, T4} → {T3} → {T5} → {T6, T7} | Freezes the response shapes listed under "API contract" below |
| W02 | {T1, T5, T6} → {T2} → {T3} → {T4} | Consumes W01's shapes only |

Concurrent subagents never run `git commit`. The fixer commits once per group after every member's tests pass. T1 of W01 is first because every later task imports its predicate. In W01, T2 and T4 only touch disjoint handlers in `mfa.ts`. If they collide on an import line, run them serially.

## Design

### How "primary" is tracked (no migration)

| State | `mfa_enabled` | `mfa_method` | `mfa_secret` | active `user_passkeys` |
|---|---|---|---|---|
| Passkey only (today) | true | `passkey` | NULL | ≥1 |
| **Passkey primary + TOTP backup (new)** | true | `passkey` | set | ≥1 |
| TOTP primary + passkey alternate (#2153) | true | `totp` | set | ≥1 |
| TOTP only | true | `totp` | set | 0 |
| SMS (unchanged, out of scope) | true | `sms` | NULL | any |

- **Primary** = `users.mfa_method`. It decides which challenge login shows first (`mfaMethod` in the challenge) and which proof the web offers first for step-up. Login already lists every allowed method (`allowedMethods`), and the web and mobile method pickers already render that list (`apps/web/src/lib/mfaChallenge.ts`, `apps/mobile/src/screens/auth/mfaChallengePresentation.ts`).
- **TOTP enrolled** = new `hasActiveTotpFactor(row)` in `routes/auth/helpers.ts`: `mfaEnabled && mfaSecret != null && (mfaMethod === 'totp' || mfaMethod === 'passkey')`.
- **Backup** = `hasActiveTotpFactor(row) && mfaMethod === 'passkey'`.
- **Promotion** already exists and stays the only way the primary moves. Deleting the last passkey promotes `totp` (`passkeys.ts` DELETE, `nextMethod`). The new remove endpoint promotes `passkey` when it removes a primary TOTP.
- Rejected: a `totp_role`/`mfa_backup_methods` column. Everything it would store is derivable, and a second source of truth is how the stale-secret states below arose. A migration would be needed only if a future factor type has no row-local evidence. If one ever is, it must sort after the newest committed file (`2027-01-22-200300-device-patches-reported-update-type.sql` at baseline). Re-check at branch time, per `apps/api/migrations/README.md`.

**Invariant this plan makes true** (advisor finding, verified at baseline): a non-null `mfa_secret` exists only when `mfa_method ∈ {totp, passkey}` **and** `mfa_enabled = true`. Today two transitions break it:
1. `DELETE /auth/passkeys/:id` can drive `mfa_enabled=false, mfa_method=NULL` and clear recovery codes, but it keeps a TOTP secret that policy disallows (`passkeys.ts` ~:1155).
2. The first-passkey branch of `/passkeys/register/verify` (`mfa_enabled=false` → `passkey`) does not clear `mfa_secret`. A dormant secret from (1) would come back as a live "backup" the user never chose.

W01 T1 fixes both and adds a test for each.

### Which flows require step-up

| Flow | "User at the keyboard" leg | Existing-factor leg | Other gates |
|---|---|---|---|
| `POST /auth/mfa/setup` (backup path) | `resolveEnrollmentStepUp`, non-consuming: current password, or for a passwordless account an `sso_reauth_manage_factor` grant (#7369) | none here (it only stages a candidate secret) | live `allowedMethods.totp`; eligibility = passkey primary with no TOTP; setup record bound to the caller's `sid` |
| `POST /auth/mfa/enable` and `/mfa/verify` setup-confirm (backup path) | same leg, consumed at the terminal write | `add_factor` grant from `POST /auth/mfa/step-up`, minted by a **passkey assertion**. Validated before the TOTP code is checked, consumed after it verifies | `consumeMFAToken` (single-use time step); same `sid` as setup; guarded write |
| `POST /auth/mfa/totp/remove` (new) | `resolveFactorManagementStepUp`: password, or `sso_reauth_manage_factor` grant | new `remove_totp` grant, provable by **passkey or TOTP** only (not SMS, not recovery) | session must be MFA-assured (`auth.token.mfa === true`, mirrors passkey DELETE); a policy-allowed factor must survive |
| `POST /auth/mfa/step-up` with `method: 'totp'` | n/a | n/a | now accepts backup TOTP via the shared predicate, so a user who lost the passkey and signed in with the authenticator can mint `delete_passkey` / `add_factor` / `rotate_recovery_codes` grants |
| `POST /auth/mfa/disable` | unchanged | unchanged | **refuses (409 `factor_removal_required`) whenever active passkeys exist** (Decision 1) |

The `add_factor` grant is minted at **Verify**, not before setup: grants live 300 s and scanning a QR code can take longer. The passwordless road has the same 300 s limit on its SSO grant. The existing `ENROLLMENT_GRANT_EXPIRED_CODE` re-verify affordance (#4050) covers it unchanged.

### Recovery-code interaction

- Adding the backup **does not issue, rotate or reveal** recovery codes. It mirrors #5038 passkey secondary add: the account already holds its set. The response **omits** `recoveryCodes` entirely. The primitive returns `[]`, and that must never reach a client that could read it as an empty replacement set.
- Removing the backup leaves the set untouched, because the account stays protected. Removal is refused when no policy-allowed factor would remain, so removal never has to clear codes. Switching MFA off entirely stays with the paths that already clear codes.
- Recovery codes remain a login factor (`recoveryAvailable`) and a `delete_passkey` step-up proof (#10671), exactly as today.
- Rotation (`/mfa/recovery-codes`) is unchanged server-side. W02 lets the user prove it with the authenticator when the passkey is missing.
- If the account has no codes left, adding a backup does not refill them. The existing **Regenerate** row is the way.

### What a passkey-only user sees (W02)

On **Settings → Profile → Multi-factor authentication** (`MFASettings.tsx`), Authenticator app row:

| Account state | Badge | Text | Action |
|---|---|---|---|
| Passkey primary, no TOTP, policy allows TOTP | "Not set up" | "Add an authenticator app as a backup, so you can still sign in if your passkey isn't available." | **Add backup** (`mfa-totp-backup-start`) |
| Passkey primary, no TOTP, policy disallows TOTP | "Not available" | "Your organization's policy doesn't allow authenticator apps." | none |
| Passkey primary + TOTP backup | "Backup" | "Use a code from your authenticator app if your passkey isn't available." | **Remove** (`mfa-totp-backup-remove-start`) |
| TOTP primary, no passkeys | "Enabled" | unchanged | **Disable** (unchanged, `/mfa/disable`) |
| TOTP primary + passkeys | "Enabled" | unchanged | **Remove** → `/mfa/totp/remove`, promotes a passkey (Decision 2) |

The add flow reuses today's views: password (or **Verify with your identity provider**), then QR code and manual key (#5319), then 6-digit code. Pressing **Verify** shows "You'll confirm with your passkey", runs the passkey assertion, then posts `/mfa/enable`. On success the text reads "Authenticator app added as a backup. Your recovery codes haven't changed." No recovery-code dialog opens.

Recovering from a lost passkey: the login picker already offers **Authenticator app** next to **Passkey**. After signing in that way, the passkey delete, add-passkey and regenerate-codes prompts show **Use authenticator app instead** when TOTP is enrolled. Rotate codes and add passkey would otherwise strand the user, because today's prompt picks passkey whenever a passkey row exists (`pickReauthTier`). A TOTP code is single-use per time step, so a step-up immediately after a TOTP login needs the next code. The prompt says so on rejection.

### Settings rule 9

This is a per-user credential, not configuration under `docs/agents/settings.md`. Home: Profile → Multi-factor authentication. Level: user. Resolver: none (row state plus `getEffectiveMfaPolicy` for `allowedMethods.totp`). Places where the user manages TOTP: 1 before, 1 after.

### Tenancy

No table, no `org_id` column, no RLS policy change: every write is to the caller's own `users` row through the existing factor-write primitives. No cascade, merge or export-policy registration applies. W01 T3 must keep one detail when extracting: `/mfa/verify` case 2 has **no ambient DB context** after its inline `authMiddleware(c, async () => {})` (comment I3 in `mfa.ts`), so the extracted helper must run the write inside `completeAdditionalMfaFactorEnrollment`/`completeInitialMfaEnrollment` exactly as today. Bare pool use there under forced RLS matches 0 rows.

### API contract (frozen by W01 for W02)

- `GET /users/me` adds `totpEnrolled: boolean`, computed in SQL from the predicate. The secret column is never selected.
- `POST /auth/mfa/setup` accepts a passkey-primary account with no TOTP. The response is unchanged.
- `POST /auth/mfa/enable` (backup): `200 { success: true, backup: true, message, tokens? }`, with no `recoveryCodes` key. `409 { error, code: 'factor_state_changed', stepUpGrantConsumed }` when the guarded write loses a race. `403 existing_factor_step_up_required` with no or invalid grant (unchanged).
- `POST /auth/mfa/totp/remove` body `{ currentPassword?, ssoReauthGrantId?, stepUpGrantId }`: `200 { success: true, mfaMethod, tokens? }`. `403 { code: 'last_mfa_factor_required' }`. `400 { code: 'totp_not_enrolled' }`. `400 { code: 'use_mfa_disable' }` (TOTP is the only factor). Errors raised after a grant was spent carry `stepUpGrantConsumed: true`.
- `POST /auth/mfa/disable`: `409 { error, code: 'factor_removal_required' }` while active passkeys exist.
- `POST /auth/mfa/step-up` operation enum adds `remove_totp`.

## Global Constraints

- **No migration.** If a task finds it needs one, stop and re-plan (slot rule above).
- **Two-phase grant idiom everywhere:** validate (non-consuming) at the gate, verify the proof, then `beginAuthIssuance` **before** spending any grant, consume, write. A failure after a consume answers with `stepUpGrantConsumed: true` (advisor finding: Redis consumption cannot roll back with Postgres).
- **Guarded writes throw inside the transaction.** A zero-row guarded `UPDATE` must `throw new AuthIssuanceConflictError()` inside `persistFactor`, then map to 409 outside. Returning a value would commit the epoch bump and the replacement session.
- **Replacement identity** for add/remove carries the caller's own assurance (`mfa: auth.token?.mfa === true`, `mfaSrc` likewise). The device binding comes from `carryForwardBinding(auth.token ?? {})`, never the request header (SR-001).
- **Opaque rejections:** factor/eligibility probes on step-up and remove use the existing uniform `rejectProof` bodies and the route's `MFA_PROOF_REJECTION_STATUS` (400). They never reveal which factors an account holds, beyond what `/users/me` already tells its owner.
- **Audit actions** are string literals (no typed registry exists for `auth.*`, verified by grep at baseline). New actions: `auth.mfa.totp.register`, `auth.mfa.totp.register.failed`, `auth.mfa.totp.remove`, `auth.mfa.totp.remove.failed`. Initial enrolment keeps `auth.mfa.setup`. `details` never carries the secret or a code.
- **Route classification:** every new route gets an entry in `apps/api/src/__tests__/writeRoutePermissionGate.contract.test.ts`. Every new session-installing call site updates the counts in `apps/api/src/services/userSession.callers.test.ts`.
- **Scoped runs:** `cd apps/api && npx vitest run <path>` (never `pnpm --filter … test -- --run`). Vitest path filters are substring matches, so list sibling files explicitly and check the reported file count.
- **Integration:** `pnpm test` does not run it. Use `pnpm test-stack up`, `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/passkeyTotpBackup.integration.test.ts`, then `pnpm test-stack down`. CI's `integration-test` job also runs it on the PR.
- **Web:** new `en` keys in all 8 locales (`de-DE en es-419 fr-CA fr-FR it-IT pt-BR tr-TR`); `data-testid` on every new interactive element. Mutations either go through `runAction` or carry the sibling handlers' `// runaction-exempt: inline-feedback handler` comment, which `no-silent-mutations.test.ts` enforces.
- **Public repo:** no customer names, hosts or production numbers in code, tests, PR bodies or docs.

## Review Focus

1. **Stale secret reactivation.** Passkey DELETE disables MFA while TOTP is policy-disallowed, then the user enrolls a first passkey again. `totpEnrolled` must be false and login must not offer TOTP (W01 T1).
2. **Concurrent confirmations.** Two `/mfa/enable` calls with distinct valid grants and codes: exactly one write, the other 409 with `stepUpGrantConsumed: true`. One `mfa_epoch` bump (W01 T7).
3. **Remove vs last-passkey delete race.** Concurrent `/mfa/totp/remove` and `DELETE /passkeys/:last` on a policy-requires-MFA account: at most one succeeds, and a policy-allowed factor survives (W01 T7).
4. **Admin reset mid-enrolment.** `mfaFactorReset` between setup and confirm: confirm fails as expired and no secret is written (W01 T7).
5. **Wrong grant shapes.** `add_factor` grant from another `sid`, a stale epoch, operation `remove_totp` presented to enable, and the reverse: each 403 (W01 T3, T5).
6. **Recovery hashes unchanged** byte-for-byte across backup add and remove (W01 T3, T5, T7).

---

## W01: API

**No migration.** PR body: `Closes #<W01 sub-issue>`. Also states Settings rule 9 (above) and lists the new audit actions.

**Execution split.** Groups {T1} → {T2, T4} → {T3} → {T5} → {T6, T7}. Sonnet-eligible: T6. Everything else Opus.

### W01 T1: Shared TOTP predicate, invariant fixes, `totpEnrolled`

**Files:** Modify `apps/api/src/routes/auth/helpers.ts` (add `hasActiveTotpFactor`; use it in `evaluatePendingMfaMethod`, `requireFreshMfaStepUp`), `apps/api/src/routes/auth/login.ts` (MFA branch `allowedMethods.totp`), `apps/api/src/routes/sso.ts` (~:4309), `apps/api/src/middleware/cfAccessLogin.ts`, `apps/api/src/routes/auth/cfAccessRedirectLogin.ts`, `apps/api/src/routes/officeAddin/auth.ts` (~:369, Decision 3), `apps/api/src/routes/auth/passkeys.ts` (DELETE `persistFactor`; first-passkey branch of register/verify), `apps/api/src/routes/users.ts` (`GET /me`). Create `apps/api/src/routes/auth/helpers.totpFactor.test.ts`.

**Interfaces, produces:**
```ts
export function hasActiveTotpFactor(row: {
  mfaEnabled: boolean | null; mfaMethod: 'totp' | 'sms' | 'passkey' | null; mfaSecret: string | null;
}): boolean
export function canAddBackupTotp(row: same): boolean // mfaEnabled && mfaMethod === 'passkey' && mfaSecret == null
// SQL twin for /users/me, same truth table:
// sql<boolean>`(${users.mfaEnabled} AND ${users.mfaSecret} IS NOT NULL AND ${users.mfaMethod} IN ('totp','passkey'))`
```

- [ ] **Tests, red first** (`helpers.totpFactor.test.ts`): a truth table over `mfaEnabled × mfaMethod × secret`, covering `hasActiveTotpFactor` and `canAddBackupTotp`. `evaluatePendingMfaMethod` answers `factor_not_enrolled` for `{mfaMethod:'sms', mfaSecret:'x'}` (stale) and `ok` for `{mfaMethod:'passkey', mfaSecret:'x'}`. `requireFreshMfaStepUp` accepts a valid code for passkey-primary + backup and rejects with the uniform body for `sms` + stale secret.
- [ ] **Tests, red first** (extend `apps/api/src/routes/auth.passkeys.test.ts`): `DELETE` that drives `remainingAllowedFactorCount` to 0 while a policy-disallowed TOTP secret exists sets `mfaSecret: null` in the same `UPDATE`. The first-passkey register branch writes `mfaSecret: null`.
- [ ] **Tests, red first** (extend `apps/api/src/routes/auth/login.test.ts`): passkey primary + secret + TOTP allowed returns `allowedMethods.totp === true`, `mfaMethod === 'passkey'`. The same row with `mfaMethod: 'sms'` returns `allowedMethods.totp === false`. Office add-in bind (extend `apps/api/src/routes/officeAddin/auth.test.ts`): passkey primary + backup + valid code binds.
- [ ] **Test, red first** (extend `apps/api/src/routes/users.test.ts`): `/users/me` returns `totpEnrolled` for each state in the Design table. The existing "never serializes secrets" assertion is extended to `mfaSecret`.
- [ ] **Implement.** Replace the four `Boolean(user.mfaSecret)` login-time checks and the three `mfaMethod !== 'totp'` proof checks with the predicate. Do **not** touch SMS predicates.
- [ ] **Verify:** `cd apps/api && npx vitest run src/routes/auth/helpers.totpFactor.test.ts src/routes/auth.passkeys.test.ts src/routes/auth/login.test.ts src/routes/users.test.ts src/routes/officeAddin/auth.test.ts` and check the file count.
- [ ] **Commit:** `fix(auth): one predicate for an enrolled authenticator app, and no dormant TOTP secret survives MFA-off`

### W01 T2: `/mfa/setup` accepts a passkey-primary account; setup record bound to the session

**Files:** Modify `apps/api/src/routes/auth/mfa.ts` (`/mfa/setup`, the two confirm readers, `enrollmentStepUpSchema` unchanged), `apps/api/src/services/mfaFactorReset.ts` only if its key cleanup changes shape (it should not; the key name stays `mfa:setup:<userId>`). Tests in `apps/api/src/routes/auth.test.ts` next to the `#4018 SSO re-auth road on /mfa/setup` block, in a new `describe('#10650 backup TOTP setup')`.

- [ ] **Tests, red first:** passkey primary, no TOTP, password ok returns 200 with `secret` and `qrCodeDataUrl`. Passkey primary + TOTP returns 400 `MFA is already enabled`. TOTP primary returns 400. SMS primary returns 400. Policy `allowedMethods.totp=false` returns 403 before any secret is generated. The stored Redis record carries `sid === auth.token.sid`. A confirm from a different `sid` answers `MFA setup expired. Please start setup again.` and leaves the record for its owner.
- [ ] **Implement.** Swap `if (user?.mfaEnabled) 400` for `if (user?.mfaEnabled && !canAddBackupTotp(user)) 400`, selecting `mfaMethod`/`mfaSecret` too. Add `sid` to the stored JSON. Both confirm readers reject a missing or mismatched `sid`. Cleanup uses compare-and-delete: delete only if the stored value still matches what was read.
- [ ] **Verify:** `cd apps/api && npx vitest run src/routes/auth.test.ts -t "10650"`.
- [ ] **Commit:** `feat(auth): stage an authenticator-app backup for passkey-primary accounts`

### W01 T3: Shared confirm helper with the backup branch

**Files:** Create `apps/api/src/routes/auth/totpFactor.ts` (helper only in this task), `apps/api/src/routes/auth/totpFactor.test.ts`. Modify `apps/api/src/routes/auth/mfa.ts` (`/mfa/enable` and `/mfa/verify` case 2 delegate to the helper), `apps/api/src/services/userSession.callers.test.ts` (move counts: `mfa.ts` down by the call sites moved, `routes/auth/totpFactor.ts` added).

**Interfaces, produces:**
```ts
export async function confirmTotpEnrollment(c: Context, auth: AuthContext, input: {
  code: string; currentPassword?: string; ssoReauthGrantId?: string; stepUpGrantId?: string;
  passwordAlreadyProven: boolean; // true for /mfa/verify case 2 (its gate is /mfa/setup)
}): Promise<Response>
```

The order is fixed, and each step has a test:
1. Read the setup record (epochs + `sid`).
2. Enrollment proof, validated.
3. `enforceExistingFactorStepUp(add_factor, consume:false)`.
4. `enforceTotpEnrollmentPolicy`.
5. `consumeMFAToken`. On failure: `auth.mfa.setup.failed` (initial) or `auth.mfa.totp.register.failed` (backup) and 400.
6. Read the live row and pick the mode: initial if `!mfaEnabled`, backup if `canAddBackupTotp`, otherwise 409 `factor_state_changed`.
7. `beginAuthIssuance`.
8. Consume the `add_factor` grant, then the enrollment grant. A failure releases the capability and reports `stepUpGrantConsumed`.
9. Initial mode: the existing `completeInitialMfaEnrollment` path, byte-for-byte. Backup mode: `completeAdditionalMfaFactorEnrollment` with `persistFactor` = `UPDATE users SET mfa_secret = $enc, updated_at = now() WHERE id = $id AND mfa_enabled AND mfa_method = 'passkey' AND mfa_secret IS NULL RETURNING id`. Zero rows → throw `AuthIssuanceConflictError` inside the transaction.
10. Install the replacement session, audit, compare-and-delete the setup record, respond.

- [ ] **Tests, red first** (`totpFactor.test.ts`, mocking the primitives per `breeze-testing`): the backup path calls `completeAdditionalMfaFactorEnrollment` (never `completeInitialMfaEnrollment`), with the identity's `mfa` copied from the token and `mobileDeviceId` from `carryForwardBinding`. The persisted `set` contains `mfaSecret` only: no `mfaMethod`, no `mfaEnabled`, no `mfaRecoveryCodes`. The response has `backup: true` and **no** `recoveryCodes` key. No grant returns 403 `existing_factor_step_up_required` and the TOTP code is **not** consumed. A wrong code returns 400 and the grant is **not** consumed. A grant for `remove_totp` or another `sid` returns 403. A conflict inside `persistFactor` returns 409 with `stepUpGrantConsumed: true`. Audit `auth.mfa.totp.register` with `{ role: 'backup', primaryMethod: 'passkey', mfaEpoch, teardownFailed }`. Initial-mode regression: an unchanged response including `recoveryCodes`, and audit `auth.mfa.setup`.
- [ ] **Tests, red first:** `/mfa/verify` case 2 with backup mode works without an ambient DB context. Assert the primitive is called, not a bare `db.update`.
- [ ] **Implement.** Move, don't rewrite: the initial branch is lifted from today's `/mfa/enable`, keeping its comments (SR2-20, #4018, I3).
- [ ] **Verify:** `cd apps/api && npx vitest run src/routes/auth/totpFactor.test.ts src/routes/auth.test.ts src/services/userSession.callers.test.ts`.
- [ ] **Commit:** `feat(auth): confirm an authenticator app as a backup factor without touching the primary or recovery codes`

### W01 T4: `/mfa/disable` refuses while passkeys survive

**Files:** Modify `apps/api/src/routes/auth/mfa.ts` (`/mfa/disable`). Tests in `apps/api/src/routes/auth.test.ts` under `describe('POST /auth/mfa/disable')`.

- [ ] **Tests, red first:** passkey primary (with or without backup) returns 409 `factor_removal_required` **before** any code is verified or grant consumed (assert `consumeMFAToken` and `consumeFactorManagementReauthGrant` not called). TOTP primary + 1 active passkey returns 409. SMS primary + passkey returns 409 (Decision 1). TOTP primary with 0 passkeys keeps today's 200 path unchanged. The passkey count is read under system context (`runOutsideDbContext` → `withSystemDbAccessContext`, as `getMfaFactorState` does).
- [ ] **Implement.** The 409 body's `error` is human-readable: "Remove your passkeys first, or remove this sign-in method on its own." Also fold `NOT EXISTS (active passkey)` into the in-transaction write's guard, so a passkey registered concurrently makes the disable lose with 409 rather than strand the passkey.
- [ ] **Verify:** `cd apps/api && npx vitest run src/routes/auth.test.ts -t "mfa/disable"`.
- [ ] **Commit:** `fix(auth): MFA disable cannot leave registered passkeys behind`

### W01 T5: `remove_totp` step-up operation and `POST /auth/mfa/totp/remove`

**Files:** Modify `apps/api/src/services/mfaStepUpGrant.ts` (`StepUpOperation` adds `'remove_totp'`), `apps/api/src/routes/auth/schemas.ts` (`STEP_UP_OPERATIONS`; `mfaStepUpSchema` keeps `recovery` restricted to `delete_passkey`), `apps/api/src/routes/auth/helpers.ts` (`enforceExistingFactorStepUp` opts union), `apps/api/src/routes/auth/mfa.ts` (`/mfa/step-up`: `remove_totp` refuses `method: 'sms'` with the uniform rejection), `apps/api/src/routes/auth/totpFactor.ts` (export `totpFactorRoutes`), `apps/api/src/routes/auth/index.ts` (mount), `apps/api/src/routes/auth/schemas.test.ts`, `apps/api/src/routes/auth/totpFactor.test.ts`.

The handler order:
1. `auth.token.mfa === true`, else 403.
2. `resolveFactorManagementStepUp`.
3. Live row read (system context) plus `getEffectiveMfaPolicy({failClosed, failClosedMethods})`.
4. Eligibility: `hasActiveTotpFactor`, else 400 `totp_not_enrolled`.
5. Surviving allowed factors = allowed active passkeys. If 0, answer 400 `use_mfa_disable` when the account has no passkeys, 403 `last_mfa_factor_required` otherwise. This applies whether or not policy *requires* MFA, because login fails closed with no allowed method (`login.ts` "no allowed methods → genericAuthError").
6. `enforceExistingFactorStepUp(remove_totp, consume:false)`.
7. `beginAuthIssuance`.
8. Consume the grant, then the management grant.
9. `completeMfaFactorRemoval`. `persistFactor` re-counts allowed passkeys under the row lock, throws `LastRequiredMfaFactorError` at 0, and runs `UPDATE users SET mfa_secret = NULL, mfa_method = CASE WHEN mfa_method = 'totp' THEN 'passkey' ELSE mfa_method END WHERE id AND mfa_secret IS NOT NULL`. Zero rows → throw `AuthIssuanceConflictError`. Recovery codes and `mfa_enabled` untouched.
10. Install the replacement session, audit `auth.mfa.totp.remove` `{ previousPrimary, newPrimary, mfaEpoch, teardownFailed }`, respond.

- [ ] **Tests, red first** (`schemas.test.ts`): `remove_totp` parses for `totp` and `passkey`. For `recovery` it is rejected. `enroll_first_factor`/`sso_reauth_manage_factor` stay compile-excluded (existing assertion).
- [ ] **Tests, red first** (`totpFactor.test.ts`): backup removal keeps `mfa_method='passkey'`, clears the secret, leaves recovery hashes untouched, and gives a 200 with `tokens`. TOTP primary + passkey promotes to `passkey`. TOTP primary with no passkey returns 400 `use_mfa_disable`. Passkeys policy-disallowed returns 403 `last_mfa_factor_required` (asserted for both `required: true` and `false`). A non-MFA-assured session returns 403. A missing, wrong-operation or other-`sid` grant returns 403 with nothing consumed. Mint via `method:'sms'` for `remove_totp` is rejected. A conflict after consume returns 409 with `stepUpGrantConsumed: true`. Failures audit `auth.mfa.totp.remove.failed` with a `reason`.
- [ ] **Implement.**
- [ ] **Verify:** `cd apps/api && npx vitest run src/routes/auth/schemas.test.ts src/routes/auth/totpFactor.test.ts src/services/mfaStepUpGrant.test.ts`.
- [ ] **Commit:** `feat(auth): remove an authenticator app without switching MFA off`

### W01 T6: Contracts and docs table (Sonnet-eligible)

**Files:** Modify `apps/api/src/__tests__/writeRoutePermissionGate.contract.test.ts` (add `'POST /api/v1/auth/mfa/totp/remove': 'own account: Removes caller\'s own authenticator app; password/SSO re-verified plus existing-factor grant'`), `apps/api/src/openapi.ts` (`/auth/mfa/totp/remove`; `/auth/mfa/enable` backup response), `apps/docs/src/content/docs/reference/users-and-roles.mdx` (audit table rows for `auth.mfa.totp.register` and `auth.mfa.totp.remove`). Create `apps/api/src/__tests__/mfaAuditActions.contract.test.ts`.

- [ ] **Test, red first** (`mfaAuditActions.contract.test.ts`): scan `routes/auth/*.ts` (non-test) for `action: 'auth.mfa.…'` literals. Every success action (not ending `.failed`) must appear in the audit table of `users-and-roles.mdx`, apart from a **frozen allowlist** of the ones undocumented at baseline (`auth.mfa.stepup.granted`, `auth.mfa.recovery_code.used`, and whatever else the first run lists). The allowlist may only shrink. It fails until the two new rows are added.
- [ ] **Implement** the table rows and the contract entries. If a docs-index freshness check exists for `apps/api/src/data/docsIndex.json`, regenerate with `scripts/build-docs-index.ts`.
- [ ] **Verify:** `cd apps/api && npx vitest run src/__tests__/mfaAuditActions.contract.test.ts src/__tests__/writeRoutePermissionGate.contract.test.ts`.
- [ ] **Commit:** `test(auth): audit-action docs contract for MFA factor events`

### W01 T7: Integration suite on real Postgres + Redis

**Files:** Create `apps/api/src/__tests__/integration/passkeyTotpBackup.integration.test.ts`. Pattern: `passkeyMfaVerify.integration.test.ts` (stub only `verifyPasskeyAuthentication` / the step-up assertion verifier; RLS, epochs, refresh families, grants and audit are real) and `mfaEnrollmentSession.integration.test.ts`.

- [ ] **Tests, red first, against W01 T1–T5:**
  1. Full add: setup → passkey step-up → enable leaves the row `passkey`/secret set, `mfa_epoch + 1`, every prior refresh family revoked, one new family for the caller, recovery hashes byte-identical.
  2. Login with `method:'totp'` on that account mints `mfa: true`.
  3. TOTP step-up `delete_passkey` on the last passkey promotes to `totp` and keeps codes.
  4. Concurrent double-enable produces exactly one write and one 409.
  5. Concurrent remove vs last-passkey delete with policy `requireMfa`: a policy-allowed factor survives.
  6. `mfaFactorReset` between setup and confirm: confirm fails, no secret.
  7. Stale-secret scenario from Review Focus 1.
  8. `/mfa/disable` with an active passkey: 409, row unchanged.
- [ ] **Run:** `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/passkeyTotpBackup.integration.test.ts`, then `pnpm test-stack down`. Paste the passing count in the PR body.
- [ ] **Commit:** `test(auth): real-DB lock for passkey-primary authenticator backup`

**W01 done when:** the full API unit suite, the integration file above and an API typecheck (`cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit`; check the exit code, never pipe it to `tail`, which hides an out-of-memory as a pass) are green, and one independent review round has run (auth surface).

---

## W02: Web and docs

**No migration.** PR body: `Closes #<W02 sub-issue>`, plus screenshots of the four Authenticator-row states.

**Execution split.** Groups {T1, T5, T6} → {T2} → {T3} → {T4}. Sonnet-eligible: T5, T6 (and the locale fan-out in T4). T1–T3 Opus.

### W02 T1: Types and store

**Files:** Modify `apps/web/src/stores/auth.ts` (user type `totpEnrolled?: boolean`), `apps/web/src/components/settings/ProfilePage.tsx` (zod user schema, lines ~53 and ~100), `apps/web/src/components/settings/StepUpPrompt.tsx` (`pickReauthTier(passkeyCount, mfaMethod, totpEnrolled)` plus an `alternateTier`).

- [ ] **Tests, red first** (`StepUpPrompt.test.tsx`): passkey primary + `totpEnrolled` gives tier `passkey` with alternate `totp`. Passkey only gives no alternate. TOTP primary is unchanged.
- [ ] **Implement.** `totpEnrolled` is optional: `undefined` (an older session) behaves as `false`, the fail-safe direction (no new button, server still authoritative).
- [ ] **Commit:** `feat(web): carry authenticator-app enrolment alongside the primary MFA method`

### W02 T2: MFASettings rows and views

**Files:** Modify `apps/web/src/components/settings/MFASettings.tsx` (props `totpEnrolled`, `totpAllowed`, `onRemoveTotp`; Authenticator-row states per the Design table; new view `'remove-totp'` with the password / IdP proof and a passkey-or-code proof selector). Create `apps/web/src/components/settings/MFASettings.totpBackup.test.tsx`.

- [ ] **Tests, red first:** each of the five row states renders its badge, text and test id. Passkey primary with no TOTP and an allowed policy shows `mfa-totp-backup-start`, and it opens the password view. Policy disallowed shows no button. TOTP primary + passkeys shows **Remove**, not **Disable**, and it calls `onRemoveTotp`. The backup success path never opens the recovery-code dialog. The remove view's proof selector defaults to passkey and switches to a 6-digit code (`mfa-totp-remove-use-code`).
- [ ] **Implement.** Reuse the existing setup and verify views. Do not fork them.
- [ ] **Commit:** `feat(web): add or remove an authenticator app as a passkey backup`

### W02 T3: ProfilePage handlers

**Files:** Modify `apps/web/src/components/settings/ProfilePage.tsx`. Create `apps/web/src/components/settings/ProfilePage.totpBackup.test.tsx`.

- [ ] **Tests, red first:** backup enable mints `add_factor` through `mintStepUpGrant({ reauth: { method: 'passkey' } })`, then posts `/auth/mfa/enable` with `stepUpGrantId`. It adopts tokens via `commitReissuedSessionIfCurrent` (not `commitMfaEnrollmentIfCurrent`), sets `totpEnrolled: true`, and leaves `mfaMethod` untouched (today's hardcoded `mfaMethod: 'totp'` must not fire). A cancelled passkey prompt keeps the code view open with no request sent. `stepUpGrantConsumed: true` on an error drops the cached grant. Remove posts `/auth/mfa/totp/remove` with `manageProof` + a `remove_totp` grant and applies the returned `mfaMethod`. The disable button on TOTP primary + passkeys routes to remove. A `factor_removal_required` 409 shows the server's message. Passkey delete, add-passkey and recovery-rotation prompts offer **Use authenticator app instead** when `totpEnrolled`, and send `method:'totp'`. A TOTP rejection right after a TOTP login shows "Wait for the next code from your authenticator app."
- [ ] **Implement.** Fetch `GET /auth/mfa/enrollment-options` once on mount for `allowedMethods.totp`. On failure, show the button and let the server answer (server authoritative). The SSO round-trip gains a web-only intent `remove_totp` in `apps/web/src/lib/ssoReauthIntent.ts` (presentational; the callback picks the grant purpose from factor state).
- [ ] **Verify:** `cd apps/web && npx vitest run src/components/settings/ProfilePage.totpBackup.test.tsx src/components/settings/MFASettings.totpBackup.test.tsx src/components/settings/StepUpPrompt.test.tsx src/lib/__tests__/no-silent-mutations.test.ts` and the existing `ProfilePage.*` / `MFASettings.*` files.
- [ ] **Commit:** `feat(web): wire authenticator-app backup into the profile page`

### W02 T4: Locales and user docs

**Files:** `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json`; `apps/docs/src/content/docs/reference/users-and-roles.mdx` (MFA section: replace "records a single primary method" with the primary + backup model; add "Authenticator app as a backup" under the passkey setup flow; document `/auth/mfa/totp/remove` and the `/mfa/disable` 409).

- [ ] **Test:** `cd apps/web && npx vitest run src/locales`. Every new key is present in all 8 locales, and `humanizedKeyRegression` is green.
- [ ] **Commit:** `docs(auth): authenticator app as a backup factor`

### W02 T5: Login test lock (Sonnet-eligible)

**Files:** Extend `apps/web/src/components/auth/LoginPage.passkeys.test.tsx` and `apps/web/src/lib/mfaChallenge.test.ts`.

- [ ] **Test** (expected to pass on arrival, since no login code changes; it locks behaviour W01 relies on): a challenge with `mfaMethod:'passkey'`, `allowedMethods:{totp:true, passkey:true}` renders `mfa-method-select` with both options. Choosing **Authenticator app** posts `/auth/mfa/verify` with `method:'totp'`. If it fails, stop: that is a W02 bug, not a test to adjust.
- [ ] **Commit:** `test(web): passkey-primary login offers the authenticator app`

### W02 T6: Mobile test lock (Sonnet-eligible)

**Files:** Extend `apps/mobile/src/screens/auth/mfaChallengePresentation.test.ts`.

- [ ] **Test:** passkey primary + `methods: ['totp','passkey']` gives `getInitialNativeMfaMethod === 'totp'`. Mobile has no enrolment UI (it hands enrolment to the web), so passkey-primary users gain native sign-in from W01 alone.
- [ ] **Verify:** `cd apps/mobile && npx vitest run src/screens/auth/mfaChallengePresentation.test.ts`.
- [ ] **Commit:** `test(mobile): passkey-primary accounts sign in with the authenticator app`

**W02 done when:** web, mobile and API suites are green. A manual pass on a `worktree-stack` covers add, sign-in-with-TOTP, delete-lost-passkey-with-TOTP and remove. Playwright's virtual authenticator stands in for the passkey (`feature-testing` skill). One review round.

---

## Decisions

Quorum: my position plus an independent `gpt-6-astra` opinion at `xhigh`, read-only, 2026-11-06. The advisor agreed with the architecture (no column, `completeAdditionalMfaFactorEnrollment`, no code rotation, a separate remove endpoint, two waves, mobile test-only). It also raised findings that this plan **adopts**: the two stale-secret transitions (W01 T1), the predicate also used at login, the session-bound setup record (T2), reserve-issuance-before-spending-grants with `stepUpGrantConsumed` (T3, T5), throw-inside-transaction for guarded writes, the MFA-assured-session gate on remove, SMS excluded from `remove_totp`, and TOTP alternatives in the web step-up prompts (W02 T3). No point was resolved against the advisor. These remain for the owner:

1. **How far the `/mfa/disable` guard reaches.** Today a TOTP-primary account with passkeys can press Disable and end up with `mfa_enabled=false` while its passkeys stay listed. Password login then skips MFA.
   - **A. Refuse whenever any active passkey exists** (advisor). Pro: no path leaves passkeys behind. Con: an SMS-primary user with passkeys must delete the passkeys first, since there is no SMS-only remover.
   - **B. Refuse only for passkey and TOTP primary.** Pro: no change for SMS users. Con: keeps the stranded state for SMS + passkey.
   - **Recommend A.** Small population, two-step path exists, and the message says what to do.
2. **Should `/mfa/totp/remove` also serve TOTP-primary accounts that hold passkeys (promoting a passkey)?**
   - **A. Yes** (my position and the advisor's). Pro: gives Decision 1A a non-destructive alternative for the common TOTP + passkey case. Same code path. Con: slightly more surface in W01.
   - **B. Backup only.** Pro: narrowest change. Con: those users can only switch MFA off through passkey deletions.
   - **Recommend A.**
3. **Where backup TOTP counts as proof.** The plan widens `/mfa/step-up`, L4 `requireFreshMfaStepUp` (approvals/PAM for SSO-only accounts) and Office add-in bind from `mfa_method === 'totp'` to the shared predicate.
   - **A. All three.** Pro: one definition of "has an authenticator". No new authority, because backup TOTP is already a full login factor. Con: passkey-primary users gain the add-in bind and L4 paths they lacked, a visible product change.
   - **B. `/mfa/step-up` only.** Pro: the minimum the lost-passkey recovery needs. Con: two definitions of the same fact.
   - **Recommend A.**
4. **Recovery codes on backup add.**
   - **A. Leave the existing set untouched** (mirrors #5038). Pro: no surprise invalidation of codes the user printed. Con: the user isn't prompted to refresh an old set.
   - **B. Rotate and show a new set.** Pro: fresh codes. Con: invalidates stored codes as a side effect of adding a factor.
   - **Recommend A** (advisor agrees).

**Out of scope (noted, not planned):** SMS-primary accounts adding TOTP (SMS enable clears the secret by design); choosing which factor is primary by hand; the policy-snapshot race the advisor noted in passkey DELETE (policy read before the transaction), which is pre-existing and worth its own issue.
