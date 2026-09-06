---
finding: RMM-QA-166
branch: fix/rmm-qa-166-mfa-reset-revokes-passkeys
base: origin/main @ fcd5b498a04abc5b4bb7938a64ce9bd9df0a1696 (#4493) — worktree fast-forwarded from 418f7a407 on 2026-09-02; the branch carried no commits of its own
risk_class: auth, rls-tenancy
rigor: HIGH — every behavior change RED-first; every control mutation-proven
---

# RMM-QA-166 — Admin MFA Reset and User Neutralization Revoke Passkeys

**Goal:** Make every "this user's second factor is gone" operation actually remove every factor. Today `POST /users/:id/mfa/reset`, last-membership neutralization, the tombstone re-invite, and access-review revocation clear only `users` columns (TOTP secret, recovery codes, method flag, sometimes phone) and never touch `user_passkeys`. Because `userIsMfaProtected` and the SR2-20 existing-factor gate count active passkey rows as protection, a "reset" user with a lost passkey stays protected, cannot re-enroll password-only, and the admin cannot reset again (the route gates on `users.mfa_enabled`, which the first reset cleared; the web button is hidden for the same reason). Exit contract (backlog row): one transactional factor-reset service revokes passkeys, TOTP, SMS, recovery, pending setup, grants and sessions; tests cover every factor and a mixed-factor user; old credentials fail; clean re-enrollment succeeds; audit identifies the administrator.

**Method note:** every claim below was re-verified by reading the cited lines in the worktree. **Main moved during design:** the first draft was written against `418f7a407`; on 2026-09-02 `origin/main` was three commits ahead (`ede3d6eb1` AI Impact page, `c9225fe8d` Intuit sample email, `fcd5b498a` RMM-QA-220 script-children RLS) and the branch — which carried no commits of its own — was fast-forwarded to `fcd5b498a`. `git diff --name-only 418f7a407 fcd5b498a` touches none of `routes/users.ts`, `routes/accessReviews.ts`, `routes/auth/*`, `services/mfaAssurance.ts`, `services/authLifecycle.ts`, `db/schema/userPasskeys.ts`, or `components/settings/UserList.tsx`; every `file:line` in §1 was re-read at `fcd5b498a` and holds unchanged. Claims not executed are marked *inferred*. No `docs/qa/probes/` directory exists in the QA repo for this finding (`grep -rl RMM-QA-166 docs/qa` hits only the backlog/register/evidence documents); the exit-evidence contract is the backlog row, so the tests in §8 are the characterization. This spec was produced autonomously under the S1 workflow: each open decision is resolved with its cost-if-wrong stated instead of being put back as a question.

## Non-goals and boundaries

- No migration. No `user_passkeys` schema change, no data backfill (D10 explains why historical leftovers are remediated by the fixed paths themselves). Migration surface stays zero, so none of the cascade/export-policy registration rows apply.
- Self-service factor removal (`/auth/mfa/disable`, `DELETE /auth/passkeys/:id`) is not changed. `/mfa/disable` (`routes/auth/mfa.ts:874-886`) also leaves passkey rows in place, but its subject still holds those passkeys and can step up with them; that is a UX gap, not a lockout, and is recorded as a non-claim (§10).
- No change to `invalidateMfaAssuranceAfterFactorChange` (`services/mfaAssurance.ts`). It stays the single assurance primitive; the new service is designed as its `mutate` half.
- No change to RLS policies, `ENABLE_2FA` gating, `getScopedUser` tenant resolution, or the admin's own `requireMfa()` step-up.
- No remote-session teardown added to the membership-removal paths (they do not tear down today; adding it is a separate finding).
- No unrelated refactoring. The only code that moves is `neutralizeUserIfOrphaned`, and it moves because a second route (`accessReviews.ts`) must call it (D5).

## 1. Verified facts (current main, `fcd5b498a`)

| # | Fact | Evidence |
|---|---|---|
| F1 | Admin reset gates on `users.mfaEnabled` only; a passkey-only leftover (`mfa_enabled=false`, live passkey rows) is refused with 400 `MFA is not enabled for this user`. | `routes/users.ts:1756-1765` |
| F2 | Admin reset's `mutate` clears `mfaSecret/mfaEnabled/mfaMethod/mfaRecoveryCodes/phoneNumber/phoneVerified` and nothing else; runs under `runOutsideDbContext(withSystemDbAccessContext(invalidateMfaAssuranceAfterFactorChange(...)))`. | `routes/users.ts:1774-1791` |
| F3 | `neutralizeUserIfOrphaned(tx, userId)` clears status/password/TOTP/recovery only; phone and passkeys untouched; leaves epoch/family bumps to `removeMembershipForScope` (order: membership delete → neutralize → `advanceUserEpochs({auth})` → `revokeAllRefreshFamilies`). | `routes/users.ts:1591-1619`, `:1643-1664` |
| F4 | Tombstone re-invite resets `users` columns only (no phone, no passkeys), inside the request-scoped invite `db.transaction`. | `routes/users.ts:1184-1252` |
| F5 | Access-review completion deletes memberships and bumps `auth_epoch` + revokes families per user under a system context; never neutralizes an orphaned user. | `routes/accessReviews.ts:463-492` |
| F6 | The only non-test `delete(userPasskeys)` is the self-service single-passkey delete. Other `update(userPasskeys)` sites are counter/last-used/rename writes. | `routes/auth/passkeys.ts:265,458,670,743,770,835,876` |
| F7 | `userIsMfaProtected = mfaEnabled OR COUNT(user_passkeys WHERE disabled_at IS NULL) > 0`; the SR2-20 gate (`enforceExistingFactorStepUp`) returns null only when it is false; `hasStrongerFactor` also counts passkeys. | `routes/auth/helpers.ts:313-329`, `:354-360`, `:544-555` |
| F8 | Login challenges MFA only when `user.mfaEnabled` — so a passkey-only leftover logs in password-only yet is "protected" for every enrollment gate. | `routes/auth/login.ts:531` |
| F9 | Passkey registration sets `mfaEnabled=true, mfaMethod='passkey'`, guarded by `WHERE mfa_enabled=false` with a zero-row throw. | `routes/auth/passkeys.ts:322-331` |
| F10 | `user_passkeys.credential_id` is `UNIQUE`; RLS policy is `user_id = breeze_current_user_id() OR breeze_current_scope() = 'system'` (FORCE). | `db/schema/userPasskeys.ts:12`; `migrations/2026-06-11-j-user-passkeys.sql:28-42` |
| F11 | Nested `withSystemDbAccessContext` inside a request context does **not** escalate ("nested calls retain the existing context"); `getCurrentDbAccessContext()` returns the active metadata; `runOutsideDbContext` exits both stores. | `db/index.ts:610-611`, `:622-628`, `:752-782` |
| F12 | `invalidateMfaAssuranceAfterFactorChange` = one `db.transaction` (advance `{mfa}` → revoke families → `mutate`) then post-commit cleanup and remote-session teardown; no factor knowledge. | `services/mfaAssurance.ts:60-76` |
| F13 | Redis artifacts keyed by user id: `mfa:setup:<userId>` (never deleted by any reset), `passkey:challenge:registration:<userId>`, `passkey:challenge:authentication:<userId>` (5-min TTL). Step-up grants (`mfa:stepup:<grantId>`) and pending logins (`mfa:pending:<tempToken>`) are keyed by opaque ids but bound to live `authEpoch`/`mfaEpoch`. | `routes/auth/mfa.ts:215,623`; `services/passkeys.ts:15,268-270`; `services/mfaStepUpGrant.ts:25-27,54`; `routes/auth/mfa.ts:287,516` |
| F14 | `writeUserAudit` is fire-and-forget (`createAuditLogAsync`) with `actorId = auth.user.id`. | `routes/users.ts:291-317` |
| F15 | Web: `UserList.tsx` renders Reset MFA only when `user.mfaEnabled`; `UsersPage.tsx` maps `mfaEnabled: Boolean(u.mfaEnabled)` from `GET /users`, whose two tenant-scoped selects expose `mfaEnabled` and nothing about passkeys. No `UserList.test.tsx` exists. | `apps/web/src/components/settings/UserList.tsx:15,155-163`; `UsersPage.tsx:79`; `routes/users.ts:1036-1074` |
| F16 | `sso.ts` already computes a per-member passkey `EXISTS` under `runOutsideDbContext(withSystemDbAccessContext(...))` joined to the tenant's membership rows — the precedent for D11. | `routes/sso.ts:1562-1610` |
| F17 | Existing reset unit tests are TOTP-shaped (`mockMfaState({mfaEnabled:true, mfaMethod:'totp'})`); `../db` and `../db/schema` are mocked without `getCurrentDbAccessContext` or `userPasskeys`; `userIsMfaProtected` is mocked (default `false`). `accessReviews.test.ts` has the same mock shape and its tx stub has no `select`. | `routes/users.test.ts:118-176,229-238,2113-2237`; `routes/accessReviews.test.ts:13-53,428-445` |
| F18 | Integration harness: `__tests__/integration/setup.ts` (real Postgres as `breeze_app`, Redis), `db-utils.createUser`, passkey rows seeded by direct insert (`passkeyMfaVerify.integration.test.ts:72-83`), `userDeleteResurrect.integration.test.ts` drives the real `DELETE /users/:id` + `POST /users/invite` with a mocked `authMiddleware` that opens a real `withDbAccessContext`. Per-worktree stack: `pnpm test-stack up|down|info`. | cited files |
| F19 | The `2026-06-18-neutralize-orphaned-users.sql` backfill post-dates the passkeys table (`2026-06-11-j`), so backfilled tombstones can carry passkey rows. | migration filenames |

## 2. Approach

**Chosen: one in-transaction factor-write primitive plus one admin-path composite, wired into all four sites; the assurance primitive is reused unchanged.** Rejected: (a) a bigger `invalidateMfaAssuranceAfterFactorChange` that knows about factors — it is deliberately factor-agnostic and self-service callers must not escalate context; (b) soft-disable of passkey rows — blocked by the `credential_id` UNIQUE constraint (D1); (c) fixing only the admin route — leaves neutralized/tombstoned users carrying a stranger's credential (F3, F4, F19).

## 3. Decisions

**D1 (decision): hard-DELETE passkey rows; capture identity into audit.** `credential_id` is UNIQUE (F10), so a soft-disabled row would make re-registering the same authenticator fail with a unique violation — defeating "clean re-enrollment", the exit contract's own criterion. Delete **every** row for the user (including already-disabled ones) so all credential ids are freed. The deleted rows' `{id, credentialId, name}` are returned by `DELETE ... RETURNING` and written into the audit `details.factors.passkeys` (capped at 100 entries; `passkeysDeleted` always carries the full count). Cost if wrong: the DB-side forensic trail of credential ids is lost — mitigated by the audit row; no reader audit is needed because no soft-disabled state is introduced (refutes verifier concern 3 by construction).

**D2 (decision): service shape.** New `apps/api/src/services/mfaFactorReset.ts`:

- `resetAllFactors(tx: Tx, userId: string): Promise<MfaFactorInventory>` — the in-tx factor write ("mutate half"). Steps, in order: (1) **context guard** — `getCurrentDbAccessContext()?.scope === 'system'` else throw `MfaFactorResetContextError` (never a silent zero-row write; F10/F11 make ambient context delete exactly zero passkey rows); (2) snapshot inventory from `users` (`mfaEnabled, mfaMethod, mfaSecret IS NOT NULL, mfaRecoveryCodes IS NOT NULL, phoneVerified, phoneNumber IS NOT NULL`) — zero rows throws (same posture as `userIsMfaProtected`); (3) `UPDATE users SET mfa_secret=NULL, mfa_enabled=false, mfa_method=NULL, mfa_recovery_codes=NULL, phone_number=NULL, phone_verified=false, updated_at=now() WHERE id=$1 RETURNING id` — length must be 1 or throw; (4) `DELETE FROM user_passkeys WHERE user_id=$1 RETURNING id, credential_id, name`; (5) return `{ previousMethod, hadTotp, hadSms, hadRecoveryCodes, hadPhone, wasEnabled, passkeys: [...], passkeysDeleted }`. Lock order is users row (the UPDATE) then factor rows, matching the primitive's documented global order (F12).
- `resetAllFactorsAndInvalidate(userId: string, reason: string): Promise<AdminFactorResetResult>` — admin-path composite: `runOutsideDbContext(() => withSystemDbAccessContext(() => invalidateMfaAssuranceAfterFactorChange(userId, reason, (tx) => resetAllFactors(tx, userId))))`, then `sweepPendingFactorArtifacts(userId)` (D8). Returns `{ inventory, mfaEpoch, cleanup, remoteSessionsTerminated, pendingSweepOk }`. Escalation lives inside because the composite is cross-user by definition; authorization stays in the route before the call (as `mfaAssurance.ts` documents for the admin caller).
- `sweepPendingFactorArtifacts(userId)` — best-effort, never throws; see D8.

Cost if wrong: if a future in-tx caller forgets the epoch/family half, factors are gone but live tokens survive until expiry. Mitigation: the docstring names the two admitted call shapes, and D3 fixes the order at every current caller with an ordering test.

**D3 (decision): the service never advances epochs or revokes families; callers do, before calling it, and neutralization advances both epochs.** Admin path: `invalidateMfaAssuranceAfterFactorChange` bumps `mfa_epoch` + revokes families before `mutate` — unchanged. Membership-removal paths: reorder to `advanceUserEpochs(tx, id, { auth: true, mfa: true })` → `revokeAllRefreshFamilies` → `neutralizeUserIfOrphaned` (was neutralize-first with `{auth}` only). This (a) resolves open decision 2 as "both": the `mfa` bump additionally kills epoch-bound step-up grants and pending logins by construction (F13) and forces `mep` mismatch on any surviving access JWT; (b) makes the global lock order user → families → factor rows hold at every site; (c) produces **no double bump anywhere** — verifier concern 5 is refuted rather than tolerated. Tests assert bump *presence* and `> before`, never an exact delta. Cost if wrong: none material — both counters are monotonic and every consumer compares for equality with the live value.

**D4 (decision): system-context assertion is the guard; row counts are evidence, not the guard.** Verifier concern 1 offered "assert affected-row count equals the pre-read inventory" as an alternative; it is rejected because under an ambient tenant context the pre-read of `user_passkeys` is *also* RLS-filtered to zero, so `0 == 0` would pass (F10). The explicit `scope === 'system'` check is the only guard that cannot be fooled; the `RETURNING` counts feed the audit and the users-row `RETURNING` length check catches a vanished row. Proof obligation: an integration test calls `resetAllFactors` under a real tenant `withDbAccessContext` and asserts it **throws** with the passkey row still present (§8, I-4).

**D5 (decision): neutralization becomes a service and access-review revocation uses it.** `neutralizeUserIfOrphaned` moves verbatim to `apps/api/src/services/userNeutralization.ts`, gains the `resetAllFactors` call after its status/password UPDATE, and returns `{ neutralized, inventory? }`. `accessReviews.ts` completion calls it per unique revoked user inside its existing system-context transaction (F5), after that user's epoch advance + family revoke (D3 order). Behavior change stated plainly: an access review that removes a user's **last** membership anywhere now disables the account and strips password and all factors — the same outcome `DELETE /users/:id` already produces; a user with any remaining membership in another tenant is untouched (the orphan check runs cross-tenant because the transaction is already system-scoped). `neutralizedUserIds` is added to the `access_review.complete` audit details. Cost if wrong: an operator expecting review revocation to be "membership only" sees the account disabled — but leaving an orphaned row active with a password is exactly the #1367 login hole that neutralization exists to close.

**D6 (decision): the admin reset gate is the inventory, not the column.** Replace the `mfaEnabled` precheck with `userIsMfaProtected(userId)` (F7): 400 with the existing message only when the account holds neither an enabled factor nor a live passkey. The `mfaState` select is removed; `previousMethod` for audit comes from the returned inventory. Cost if wrong: an account with a stray `mfa_secret` but `mfa_enabled=false` and no passkeys is refused — no gate treats that state as protection (F7, F8), so nothing is stuck.

**D7 (decision): audit stays post-commit and fire-and-forget, written from the inventory.** Open decision 3 is resolved "not transactional": the audit must record post-commit outcomes (`teardownFailed`, `pendingSweepOk`) that only exist after the transaction, and holding the system-context transaction open across Redis and remote-session teardown is exactly what verifier concern 6 forbids. `writeUserAudit` (F14) is called after the composite returns with `details: { method, factors: { totp, sms, recoveryCodes, phone, passkeys: [{id, credentialId, name}] }, passkeysDeleted, mfaEpoch, teardownFailed, pendingSweepOk }` and `actorId` = the admin. Cost if wrong: an audit row can be lost on a process crash in the milliseconds between commit and enqueue — the same exposure every user audit has today; accepted.

**D8 (decision): pending-artifact sweep by key, epochs for the rest.** Post-commit and best-effort: `DEL mfa:setup:<userId>`, `DEL passkey:challenge:registration:<userId>`, `DEL passkey:challenge:authentication:<userId>`. `mfa:stepup:<grantId>` and `mfa:pending:<tempToken>` are not enumerable by user and are not swept; they are dead by construction after the `mfa_epoch` bump (F13). Redis unavailable → `pendingSweepOk=false`, logged, recorded in audit, never thrown. Cost if wrong: a 10-minute `mfa:setup` secret outlives the reset only when Redis is down at that instant, and it is unusable without a live token anyway.

**D9 (decision): tombstone re-invite pre-flights the composite reset.** The invite transaction runs in the caller's ambient context (F4), where a passkey delete would be the silent-zero-row trap (F10) and the D4 guard would throw — so the sweep cannot live inside that transaction. Instead, before `db.transaction`: ambient-context `SELECT id, status, password_hash FROM users WHERE email = $1` (same visibility as the in-tx lookup); if `status='disabled' AND password_hash IS NULL` (the exact tombstone predicate at `users.ts:1226`), call `resetAllFactorsAndInvalidate(id, 'invite-resurrect')` and only then open the invite transaction. The in-tx tombstone branch keeps its `users`-column clears and adds `phoneNumber: null, phoneVerified: false` for parity. Safety: a tombstone cannot acquire factors between pre-flight and resurrect (disabled, no password, epochs already bumped — no token can be minted), and a pre-flight failure fails the invite **before** any write. Cost if wrong: one indexed lookup per invite of an existing email; the composite's cleanup/teardown steps are no-ops for a tombstone.

**D10 (decision): no data migration.** Historical leftovers come in two shapes. Active users reset under old code (`mfa_enabled=false`, live passkeys): the fixed route (D6) plus the visible button (D11) let the admin reset them again, which is the correct remediation per account. Tombstones with passkeys (F19): inert until resurrected — the passkey path is only reachable from a pending MFA record minted after a password login (`routes/auth/login.ts:531-544`), and a tombstone has no password — and D9 sweeps them at resurrection. A blanket `DELETE FROM user_passkeys WHERE mfa_enabled=false` would be wrong for no state the code can produce legitimately and right only for the bug's leftovers, which the fixed paths already cover. Cost if wrong: an inert stale row persists on a never-resurrected tombstone.

**D11 (decision): `GET /users` exposes `mfaProtected`, computed from tenant-resolved ids.** The two tenant-scoped list selects (F15) are unchanged; when the result is non-empty, a second read under `runOutsideDbContext(withSystemDbAccessContext(...))` selects `DISTINCT user_id FROM user_passkeys WHERE user_id IN (<ids from the membership join>) AND disabled_at IS NULL`; each row gets `mfaProtected = mfaEnabled || hasActivePasskey`. This satisfies verifier concern 4: the system context reads only ids the caller's own membership join resolved (precedent F16). Web: `UserList` renders Reset MFA when `user.mfaProtected ?? user.mfaEnabled` (explicit `false` hides; a payload without the field falls back to the old flag); `UsersPage` maps `mfaProtected: Boolean(u.mfaProtected ?? u.mfaEnabled)`. Cost if wrong: one bounded extra query per list load.

**D12 (decision): test-double surface changes are named, not discovered.** `users.test.ts` and `accessReviews.test.ts` must add `getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' }))` to the `../db` mock (else the D4 guard fails every reset for the wrong reason) and `userPasskeys` columns to the `../db/schema` mock (else `eq(userPasskeys.userId, …)` throws on `undefined`); tx stubs gain `delete(...).where().returning()` and (accessReviews) `select` for the orphan checks. These are recorded in the plan as mock-surface commits separate from the behavior REDs so each RED fails on the assertion, not on a `TypeError`.

## 4. Contracts per file

| File | Change | Contract |
|---|---|---|
| `apps/api/src/services/mfaFactorReset.ts` (new) | `resetAllFactors(tx, userId)`, `resetAllFactorsAndInvalidate(userId, reason)`, `sweepPendingFactorArtifacts(userId)`, `MfaFactorResetContextError`, `MfaFactorInventory`, `AdminFactorResetResult` | D2, D4, D8. Imports `getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext, db` from `../db`; `users, userPasskeys` from `../db/schema`; `invalidateMfaAssuranceAfterFactorChange`; `getRedis`. Never bumps epochs. Docstring names the two admitted call shapes. |
| `apps/api/src/services/userNeutralization.ts` (new) | `neutralizeUserIfOrphaned(tx, userId): Promise<{ neutralized: boolean; inventory?: MfaFactorInventory }>` | D5. Body is the moved function (comment block included) + `resetAllFactors` after the status/password UPDATE. Callers own epochs/families and must call it **after** them (D3). |
| `apps/api/src/routes/users.ts` | Reset route: gate → `userIsMfaProtected`; body → `resetAllFactorsAndInvalidate(userId, 'admin-mfa-reset')`; audit from inventory (D6, D7). `removeMembershipForScope`: order → epochs `{auth, mfa}` → families → `neutralizeUserIfOrphaned` (import from service; local function deleted). Invite: tombstone pre-flight (D9) + phone parity in the in-tx branch. List: `mfaProtected` (D11). | Route authorization (`requirePermission`, `requireMfa`, self-refusal, `getScopedUser`) unchanged and still precedes escalation. |
| `apps/api/src/routes/accessReviews.ts` | Per unique revoked user inside the existing system tx: `advanceUserEpochs({auth:true, mfa:true})` → `revokeAllRefreshFamilies` → `neutralizeUserIfOrphaned`; collect `neutralizedUserIds` into the audit details. | D3, D5. Post-commit cleanup loop unchanged. |
| `apps/api/src/services/mfaFactorReset.test.ts` (new) | Unit: guard throws under `{scope:'partner'}` / `undefined`; zero users row throws; ordering UPDATE users before DELETE passkeys; inventory shape; composite wraps `runOutsideDbContext`→`withSystemDbAccessContext`→primitive and sweeps three keys; sweep never throws. | Mock style of `services/mfaAssurance.test.ts`. |
| `apps/api/src/services/userNeutralization.test.ts` (new) | Unit: short-circuits on partner link; short-circuits on org link; neutralizes + calls `resetAllFactors` when orphaned; returns inventory. | |
| `apps/api/src/routes/users.test.ts` | Reset describe: replace `mockMfaState` with `userIsMfaProtectedMock`; new cases per §8 U-1..U-4; DELETE describe: U-5, U-6 (order + passkey delete); invite: U-7 (tombstone pre-flight); list: U-8. Mock-surface per D12. | Existing assertions on `runOutsideDbContext`/`withSystemDbAccessContext`/`runPostCommitCleanup`/`actorId` are kept. |
| `apps/api/src/routes/accessReviews.test.ts` | U-9, U-10; mock-surface per D12. | Existing completion tests keep passing (epoch/family shapes now include `mfaEpoch`). |
| `apps/api/src/__tests__/integration/adminMfaReset.integration.test.ts` (new) | I-1..I-3. Drives the real route with the `userDeleteResurrect` harness pattern. | |
| `apps/api/src/__tests__/integration/mfaFactorReset.integration.test.ts` (new) | I-4..I-6 (RLS guard, atomicity, credential re-registration). | Runs the service directly like `mfaAssurance.integration.test.ts`. |
| `apps/api/src/__tests__/integration/userDeleteResurrect.integration.test.ts` | I-7, I-8 added to the existing describes. | Existing three proofs unchanged. |
| `apps/web/src/components/settings/UserList.tsx` | `User.mfaProtected?: boolean`; render condition `mfaProtected ?? mfaEnabled`. | D11. |
| `apps/web/src/components/settings/UsersPage.tsx` | Map `mfaProtected`. | D11. |
| `apps/web/src/components/settings/UserList.test.tsx` (new) | W-1..W-3. | i18n pattern of `settings/ChangePasswordForm.test.tsx` (`i18n`, `loadLocale` from `@/lib/i18n`, `changeLanguage('en')`); `en` key `userList.actions.resetMfa` = "Reset MFA" at `apps/web/src/locales/en/settings.json:3937`. |
| `docs/superpowers/specs/…` (this file), plan under `docs/superpowers/plans/` | | |

## 5. Data flow (admin reset, after)

1. `POST /users/:id/mfa/reset` → `requirePermission(USERS_WRITE)` → `requireMfa()` → self-refusal → `getScopedUser` (tenant) → `userIsMfaProtected` (system probe; 400 if false).
2. `resetAllFactorsAndInvalidate(id, 'admin-mfa-reset')`: system context → one transaction: `advanceUserEpochs({mfa})` → `revokeAllRefreshFamilies` → `resetAllFactors` (guard, snapshot, UPDATE users RETURNING, DELETE passkeys RETURNING) → commit → `runPostCommitCleanup` → `terminateUserRemoteSessions` → Redis key sweep.
3. `writeUserAudit(... 'user.mfa_reset', details from inventory + outcomes)`; response `{ success: true }`.

Failure modes: guard/zero-row/DELETE error inside the transaction → whole transaction rolls back (no epoch bump, no family revoke, no column clear, no passkey delete) → 500; post-commit failures are recorded, never undo the commit.

## 6. Error handling

- `MfaFactorResetContextError` and the zero-row throws are programming-error signals (500), deliberately loud: the alternative is the silent-zero-row trap the codebase already documents at `users.ts:1770-1775`.
- Redis sweep: swallow, log `[mfa-factor-reset] pending-artifact sweep failed` with `userId` only, set `pendingSweepOk=false`.
- Tombstone pre-flight failure: propagate → invite fails before any write.

## 7. Open decisions — resolved

| Brief's open decision | Resolution |
|---|---|
| Disable vs hard-delete passkeys | Hard delete (D1). |
| Advance `mfa_epoch` in neutralization too | Yes, both, by the caller, before the factor write; no double bump (D3). |
| Transactional audit | No; post-commit from inventory (D7). |

## 7b. Verifier concerns — disposition

Every concern in the brief's `verdict.fixDesignConcerns` is either satisfied by a decision or refuted with evidence; none is deferred.

| # | Concern (abridged) | Disposition |
|---|---|---|
| C1 | `user_passkeys` RLS is `user_id = current OR scope='system'`; the service must assert system context or compare affected rows to a pre-read inventory, else ambient callers silently update zero rows. | **Satisfied by D4** (explicit `getCurrentDbAccessContext()?.scope === 'system'` guard, thrown as `MfaFactorResetContextError`). The row-count alternative is **refuted**: under ambient context the pre-read is RLS-filtered to the same zero, so `0 == 0` passes (F10). Executed proof: I-4. |
| C2 | `credential_id` is UNIQUE; soft-disable blocks re-registering the same authenticator; prefer hard DELETE and capture credential ids into audit. | **Satisfied by D1** (hard DELETE of every row, ids into `details.factors.passkeys`). Executed proof: I-3 re-inserts a deleted `credential_id`. |
| C3 | If disable is kept, every active-passkey reader must filter `disabled_at IS NULL`. | **Moot by construction** — no soft-disabled state is introduced (D1). The one new reader (D11 list probe) still filters `disabled_at IS NULL` so it agrees with `userIsMfaProtected` on the rows that survive a self-service disable. |
| C4 | The users-list factor count must stay inside the caller's tenant resolution; no cross-tenant `user_passkeys` read in system context without the membership join. | **Satisfied by D11**: the system-context read is keyed `user_id IN (<ids the tenant-scoped membership join already returned>)`; precedent `sso.ts:1562-1610` (F16). U-8 asserts the probe runs after, and only over, the tenant select's ids. |
| C5 | `neutralizeUserIfOrphaned` leaves epoch/family bumps to its caller; a service that also bumps would double-bump — make the contract explicit so tests don't assert exact deltas. | **Refuted, not tolerated, by D3**: the factor service never bumps; callers bump `{auth, mfa}` once, before the factor write. No site double-bumps. Tests assert presence and `> before`, never a delta. |
| C6 | Transactional audit is reasonable but must not hold the system-context tx open across Redis / remote-session teardown. | **Satisfied by D7**: audit stays post-commit, fire-and-forget, written from the returned inventory; the transaction closes before `runPostCommitCleanup`, teardown, and the D8 sweep run. |

## 8. RED test list

Every test is written first, watched fail against current main for the stated reason, and its control is proven to discriminate by the stated mutation (mutate → fail → revert). The failing output is retained in the commit message.

**Unit — `routes/users.test.ts`**
- U-1 `resets a passkey-only target even when users.mfaEnabled is false`: `userIsMfaProtectedMock → true`; tx stub captures `delete(userPasskeys)` and `update(users)` with `mfaEnabled:false, phoneNumber:null`; asserts 200, delete called, `mfaEpoch`-shaped update, `revokedReason`-shaped update, `runPostCommitCleanup(TARGET)`, audit `actorId:'user-123'` with `passkeysDeleted`. RED on main: 400 (column gate). Mutation: drop the DELETE from the service → assertion on delete fails.
- U-2 `resets every factor for a mixed TOTP+SMS+recovery+two-passkey target`: RETURNING two passkey rows; asserts audit `details.factors.passkeys` length 2 and column clears including `phoneVerified:false`. RED: route never issues a passkey delete. Mutation: omit `phoneNumber` from the clear set → fails.
- U-3 `sweeps mfa:setup and passkey challenge keys after commit`: `getRedis` mock records `del`; asserts the three keys and that `del` is called after `db.transaction` resolved (call-order array). RED: no sweep exists. Mutation: remove one key → fails.
- U-4 `400s when the inventory is empty (not merely mfaEnabled=false)`: `userIsMfaProtectedMock → false`, asserts 400 and `db.transaction` not called. Replaces the current "no MFA enabled" case; RED as written on main only in the negative direction (it passes today by accident of the column gate), so the discriminating proof is U-1, which cannot pass while the column gate exists.
- U-5 `DELETE /users/:id: epochs {auth, mfa} + families are advanced before neutralize, and passkeys are deleted for an orphan`: call-order array over tx `update`/`delete`; asserts `mfaEpoch` in the epoch update, `status:'disabled'` update **after** the `revokedReason` update, `delete(userPasskeys)` called. RED: today neutralize runs first and no passkey delete exists. Mutation: swap the order back → fails.
- U-6 `DELETE /users/:id: a user with another membership is not neutralized and keeps passkeys`: `hasOtherMembership:true`; asserts no `status:'disabled'` update and `delete` called once (the membership) — discriminates D5's orphan check.
- U-7 `POST /users/invite: a tombstone email pre-flights the composite reset before the invite transaction`: `db.select` returns `{status:'disabled', passwordHash:null}`; asserts `resetAllFactorsAndInvalidate` (spied via `vi.mock('../services/mfaFactorReset', importOriginal)`) called with the tombstone id before `db.transaction`. RED: no pre-flight exists. Mutation: move the call after the transaction → order assertion fails.
- U-8 `GET /users: rows carry mfaProtected=true for a passkey-only member`: second select returns the member id; asserts `mfaProtected:true` with `mfaEnabled:false`, and that the passkey read runs under `withSystemDbAccessContext` **after** the tenant select. RED: field absent. Mutation: return `mfaEnabled` only → fails.

**Unit — `routes/accessReviews.test.ts`**
- U-9 `completion that orphans a revoked user neutralizes them (status disabled, password null, passkeys deleted) after epochs {auth, mfa} + families`: tx stub `select` returns no links; asserts shapes + order + `neutralizedUserIds` in the audit call. RED: no neutralization. Mutation: drop the `mfa:true` → the `mfaEpoch`-shape assertion fails.
- U-10 `completion leaves a still-member revoked user active`: `select` returns a link; asserts no `status:'disabled'` update and no passkey delete.

**Unit — `services/mfaFactorReset.test.ts`**, **`services/userNeutralization.test.ts`**: as listed in §4; the guard test is RED by non-existence and discriminated by returning `{scope:'system'}`.

**Integration (real Postgres as `breeze_app`, real Redis)**
- I-1 `adminMfaReset`: seed target with TOTP secret + recovery codes + `mfaMethod='sms'`, verified phone, two passkey rows, a refresh family, `mfa:setup:<id>` and `passkey:challenge:registration:<id>` keys; admin (full-access partner caller) POSTs reset → 200; assert `userIsMfaProtected(id) === false`, zero `user_passkeys` rows, all six columns cleared, `auth_epoch` unchanged and `mfa_epoch > before`, family `revoked_at` set with reason `admin-mfa-reset`, both Redis keys absent, audit row `user.mfa_reset` with `actor_id` = admin and `details.passkeysDeleted === 2`. RED on main: passkey rows remain and `userIsMfaProtected` stays true.
- I-2 `adminMfaReset: passkey-only target (mfa_enabled=false) is reset, not refused`: seed passkey row only → 200 and rows gone. RED: 400.
- I-3 `adminMfaReset: clean re-enrollment`: after I-1's reset, drive `POST /auth/mfa/setup` with `currentPassword` and no `stepUpGrantId` → 200 (the SR2-20 gate no longer demands proof from the lost passkey), then `POST /auth/passkeys/register/verify`-equivalent: insert a passkey with the **same** `credential_id` as one deleted in I-1 → succeeds (D1's unique-constraint argument, executed). RED on main: setup 403s (existing-factor step-up required) and the insert violates UNIQUE.
- I-4 `mfaFactorReset: refuses to run under a tenant context` — `withDbAccessContext({scope:'partner', …}, () => db.transaction(tx => resetAllFactors(tx, id)))` rejects with `MfaFactorResetContextError`; passkey row still present; `mfa_enabled` unchanged. This is the executed proof for verifier concern 1. Mutation: bypass the guard → the test observes a silent zero-row delete (row still present, no throw) and fails.
- I-5 `mfaFactorReset: atomicity` — inject a throwing `mutate` step after `resetAllFactors` inside `invalidateMfaAssuranceAfterFactorChange` (wrap: `tx => { await resetAllFactors(tx,id); throw … }`) → rejection; passkey rows, columns, `mfa_epoch`, and family are all unchanged (rollback across the epoch bump, family revoke, column clear, and passkey delete).
- I-6 `mfaFactorReset: deletes already-disabled passkey rows too` — seed one live + one `disabled_at` row → both gone, `passkeysDeleted === 2`.
- I-7 `userDeleteResurrect: last-membership removal neutralizes factors` — seed TOTP + phone + passkey; `DELETE /users/:id` → status disabled, password null, six columns cleared, zero passkey rows, `auth_epoch` and `mfa_epoch` both `> before`. RED: passkey row and phone survive.
- I-8 `userDeleteResurrect: re-inviting a tombstone that still carries a stale passkey sweeps it before resurrection` — seed a tombstone directly (status disabled, password null, one passkey) → `POST /users/invite` same email → 201/200, zero passkey rows, `phone_verified=false`. RED: passkey row survives resurrection.

**Web — `UserList.test.tsx`**
- W-1 `shows Reset MFA for a passkey-only user (mfaEnabled=false, mfaProtected=true)`. RED: button hidden. Mutation: render on `mfaEnabled` only → fails.
- W-2 `hides Reset MFA when mfaProtected=false even if a stale mfaEnabled=true is sent`.
- W-3 `falls back to mfaEnabled when the payload has no mfaProtected` (legacy API compatibility).

## 9. Verification battery

Local gates before push, in this order; each command's output is retained as evidence:

- Unit (API): `pnpm --filter @breeze/api vitest run src/services/mfaFactorReset.test.ts src/services/userNeutralization.test.ts src/services/mfaAssurance.test.ts src/routes/users.test.ts src/routes/accessReviews.test.ts src/routes/auth/helpers.test.ts` — RED outputs captured per test before implementation; GREEN after.
- Typecheck (API + web) on the touched packages.
- Integration on a **private** per-worktree stack: `pnpm test-stack up` → `pnpm --filter @breeze/api test:integration -- src/__tests__/integration/adminMfaReset.integration.test.ts src/__tests__/integration/mfaFactorReset.integration.test.ts src/__tests__/integration/userDeleteResurrect.integration.test.ts src/__tests__/integration/mfaAssurance.integration.test.ts src/__tests__/integration/passkeyMfaVerify.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts` → `pnpm test-stack down`. The existing `rls-coverage` run proves no policy or allowlist drifted (no schema change expected — the run is a tripwire, not a claim of coverage change).
- Web: `pnpm --filter @breeze/web vitest run src/components/settings/UserList.test.tsx` plus lint on the three touched web files; the `no-silent-mutations` suite still passes (the reset handler in `UsersPage.tsx` is not touched).
- Mutation proofs: for each control in §8 the named mutation is applied, the failing output captured, and the mutation reverted; the plan records each as a checklist line.
- Post-push: confirm workflow runs attached to the head (`gh run list --branch fix/rmm-qa-166-mfa-reset-revokes-passkeys`; fallback `gh workflow run ci.yml --ref …`), exact-head **Test API**, **Test Web**, and **Integration Tests** green; one independent review round (cap: one, unless a fix touches auth/RLS again).

Post-implementation greps (cheap tripwires): `grep -rn "mfaEnabled" apps/api/src/routes/users.ts` shows no gate on the reset route; `grep -rn "neutralizeUserIfOrphaned" apps/api/src` resolves to the service plus exactly two callers; `grep -rn "delete(userPasskeys)"` non-test hits = self-service delete + the service; no `disabledAt` writes were introduced.

## 10. Non-claims

- Not claimed: remote-session teardown on membership removal or access-review revocation (unchanged; separate finding).
- Not claimed: self-service `/mfa/disable` removes passkeys (it does not; its subject still controls them — out of scope).
- Not claimed: sweeping `mfa:stepup:*` / `mfa:pending:*` by key; their invalidation is by epoch binding (F13), executed indirectly by I-1's `mfa_epoch > before` and the existing `pendingMfaEpoch` / step-up grant suites, not by a key-level assertion here.
- Not claimed: cleanup of stale passkey rows on tombstones that are never re-invited (D10; inert by F8/F13 and the null password hash).
- Not claimed: any change to what `GET /users/me` or `PATCH /users/me` return; `mfaProtected` is list-only.
- *Inferred*, to be executed in I-3: `POST /auth/mfa/setup` returns 200 for the reset user with password only. The trace (`resolveEnrollmentStepUp` password road → `mfaEnabled=false` → `enforceExistingFactorStepUp` short-circuits on `userIsMfaProtected=false`) is verified by reading; the status code is not yet observed.
- Not claimed: production deployment, fleet enablement, or that historical leftovers are already remediated — each requires an admin to run the now-working reset (D10).

## 11. Ship sequence

1. Docs commit (this spec + the executable plan).
2. Mock-surface commit (D12) — no behavior, existing suites green.
3. Service commits, each RED→GREEN with the failing output in the message: `mfaFactorReset.ts` (+ unit), `userNeutralization.ts` (+ unit).
4. Route commits: admin reset (U-1..U-4), membership removal (U-5, U-6), invite pre-flight (U-7), list field (U-8), access reviews (U-9, U-10).
5. Integration commits (I-1..I-8) on the private stack; mutation proofs recorded.
6. Web commit (W-1..W-3).
7. Battery (§9), push, exact-head CI, one review round; PR body states the D5 behavior change and the D10 remediation note. Never merged or pushed to `main` by this workflow.
