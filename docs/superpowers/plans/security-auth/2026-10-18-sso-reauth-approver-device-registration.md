# SSO Re-Auth Road for Approver-Device Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a passwordless (SSO-only) account with no passkey and no TOTP mint a `register_approver_device` grant from a fresh SSO re-authentication, so it can register this browser as an approver device from Profile → Approval security (#9007; the still-open part of #8862).

**Architecture:** No new route, no new grant operation, no schema change. `POST /sso/reauth/start` and the SSO callback stay exactly as they are: the callback already mints a single-use, session-bound `enroll_first_factor` grant (no factor yet) or `sso_reauth_manage_factor` grant (account holds a factor), and returns it as `/settings/profile#ssoReauthGrant=<id>`. `POST /authenticator/register-grant` learns to accept that grant as an alternative to `currentPassword`. It redeems the grant through the existing `resolveEnrollmentStepUp` (consume, single use) and then mints `register_approver_device` exactly as it does after a password proof. On the web, `pickReauthTier` gains an `sso` tier for `hasPassword === false`, and the profile page's existing SSO-intent stash gains an `approver_device` intent so the IdP round-trip lands back on the register form.

**Tech Stack:** Hono + TypeScript + Zod (apps/api), Redis step-up grants (`services/mfaStepUpGrant.ts`), Vitest, Astro + React islands + react-i18next (apps/web).

**Spec:** GitHub issue #9007 (body is the spec). Background: #8862 (original report and its three comments), `docs/superpowers/plans/2026-08-25-sso-reauth-enrollment-grant.md` (the #4018 road this reuses), `docs/superpowers/plans/2026-07-21-authenticator-register-grant.md` (the #2707 register-grant design), `docs/superpowers/plans/security-auth/2026-06-14-breeze-authenticator-phase2-browser-approver.md`.

## Scope: what is done, what this covers, what stays out

**Already done. Do not re-plan it.** The `"exp" claim timestamp check failed` defect from #8862 was fixed by #8974 (commit `a9018453f4`, on main):
- `apps/api/src/routes/sso.ts` — `REAUTH_ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 300`, passed as `{ clockToleranceSeconds, mode }` to the id_token verify only when `callbackMode === 'reauth'`.
- `apps/api/src/services/sso.ts` — `clockToleranceSeconds` option, defaulting to 0 for login and link.
- A re-auth verify failure now redirects to `/settings/profile?ssoReauthError=idp_verify_failed` (not `/login?error=sso_error`) and audits `failureKind`. Pinned by `apps/api/src/routes/sso.reauth.test.ts` (asserts `{ clockToleranceSeconds: 300, mode: 'reauth' }` and the `idp_verify_failed` redirect). The web maps it in `ProfilePage.tsx` (`idp_verify_failed: 'profilePage.ssoReauthIdpVerifyFailed'`).
- The only closure evidence still owed for that part is a retest by the Entra reporter on a build that contains #8974.

**Also done:** hiding Change password for passwordless accounts (#9008, closed by PR #9147; `ProfilePage.noPasswordChange.test.tsx`).

**This plan covers:** the SSO re-auth road for `POST /authenticator/register-grant` and the Approval-security UI that uses it (#9007).

**Out of scope, and where it is tracked:**
- **A first-password ("Set a password") path** for passwordless accounts, gated by an SSO re-auth grant (`POST /auth/change-password` still calls `requireCurrentPasswordStepUp`). It does not share code with this plan beyond the grant. #9008 records it as an open product question; **flag for Todd as a candidate follow-up issue**.
- **SSO-required org, user still holds a password hash.** `register-grant`'s password road does not consult the SSO-required policy, and `/sso/reauth/start` refuses any account with a hash (`'Account has a password'`). Such a user keeps the password road. Changing that means changing the start route's "one road per account" rule. Candidate follow-up, not this plan.
- **MFA-required-but-unenrolled accounts** get `428` on `/authenticator/*` (`isMfaEnrollmentExemptPath` in `apps/api/src/middleware/auth.ts` does not exempt it). That is intended: they enroll a factor first, and the tier then becomes `totp`/`passkey`. No change.
- **`#4470` 400 migration for the rest of the auth surface.** This plan moves only `register-grant` to 400 (Decision 1).

## Decisions (advisor quorum: Claude position + `codex exec` read-only, `xhigh`)

Both advisors chose the same road independently. Two points differed and are resolved below on the merits.

1. **Road: exchange at `register-grant` (option B).** `register-grant` accepts `{ currentPassword? , ssoReauthGrantId? }` and calls `resolveEnrollmentStepUp(c, auth, input, { keyPrefix: 'authenticator:pwd', consume: true, rejectionStatus: 400 })`, then mints `register_approver_device` as today.
   - Rejected **A** (a `purpose` body on `/sso/reauth/start`, stored on a new `sso_sessions` column, callback mints `register_approver_device` directly): needs a migration, widens what the unauthenticated callback can mint, and puts a client-chosen purpose on a security row, all for a proof of the same strength.
   - Rejected **C** (a new grant operation or callback mode): the callback would still need to know the intent, so it is A by another name.
   - B reuses the existing eligibility check (passwordless only), purpose selection (`userIsMfaProtected`, the same predicate the callback uses), bind tuple and single-use consume. It adds one new *acceptor* of an existing grant and no new *minter*.
   - **Accepted policy extension:** an `enroll_first_factor` / `sso_reauth_manage_factor` grant may now be spent either on factor enrollment/management **or** on one exchange for a `register_approver_device` grant. It is still one spend total (Redis `GETDEL`). The doc comments that say `enroll_first_factor` installs a first factor "and nothing else" are updated in Task 1. The approver routes (`enforceApproverRegisterStepUp`) still accept **only** `register_approver_device`. An SSO grant presented directly as `registerGrantId` fails `bindsMatch` on `operation`.
2. **Rejection status: 400, uniform across the route (Codex's position; Claude had argued for keeping 401).** It resolves in favour of 400 because:
   - The `#4470` invariant (`rejectProof` doc comment in `helpers.ts`) reserves 401 for the bearer.
   - The new SSO-road failures (`enrollment_proof_required`, `enrollment_grant_expired`) would otherwise land on the web's "401 means session expired, reload" branch.
   - The current web client already treats `400 + code: 'invalid_credentials'` as a proof rejection (`ApproverDevicesSection.tsx` `isProofRejection`), so moving the password road to 400 is backward compatible with a stale browser tab.
   - Mobile never calls this route (it uses the login-time grant).
   - Status stays uniform within the call site, so the password/passwordless oracle stays closed.
3. **Binding.** The SSO grant is bound to `{ userId, operation, authEpoch, mfaEpoch, sid }` captured at `/sso/reauth/start` and re-checked at the callback (`validateSessionBinding`). `resolveEnrollmentStepUp` rebuilds that tuple from the **requesting bearer's** `auth.token.sid` and **live** epochs, so the grant fails if any of these differ: another session, another user, a factor change since (mfa_epoch), or a password/membership change since (auth_epoch). The minted `register_approver_device` grant is bound to the same live tuple, as on the password road. Callback `mode` is untouched: still `reauth`, still redirects to `/settings/profile#ssoReauthGrant=<id>`, still mints no tokens.
4. **TTL is not capped across the exchange (default; Todd may override).** The SSO grant lives 300 s. The exchange mints a fresh 300 s register grant, so the worst-case age of the IdP `auth_time` at `/devices/webauthn/verify` is about 600 s (plus the callback's freshness skew). The password road has the same shape: proof first, then a 300 s grant. The WebAuthn ceremony needs the window. Capping would mean storing the SSO grant's mint time and threading it through `consumeStepUpGrant`, which is new surface for little gain. **Recorded as a decision for Todd** in the PR body.
5. **Matrix** (all verified against main):

   | Account | Web tier | Server path | Result |
   |---|---|---|---|
   | Passwordless, no factor | `sso` (new) | callback mints `enroll_first_factor` → `register-grant {ssoReauthGrantId}` | **new road works** |
   | Passwordless, SMS only | `sso` (new; SMS already falls through `pickReauthTier`) | callback mints `sso_reauth_manage_factor`; resolver expects the same (both use `userIsMfaProtected`) | works |
   | Password hash present (SSO or not) | `password` | unchanged password road; `/sso/reauth/start` refuses; a grant offered without a password → 400 `invalid_credentials` | unchanged (status 401→400) |
   | Passkey or TOTP | `passkey` / `totp` | `POST /auth/mfa/step-up` mints the grant; `register-grant` 403s `stronger_factor_required` **before** either proof road is touched | unchanged |
   | Org requires SSO | as above by hash state | passwordless → `sso`; stale hash → password road (out of scope above) | — |
   | `ENABLE_2FA=false` | as above | `userHasStrongerReauthFactor` fails open → `register-grant` reachable; a leftover factor makes both callback and resolver pick `sso_reauth_manage_factor` | works, no divergence |

   `register-grant` has never accepted a passkey or TOTP proof: `registerGrantMintSchema` is `{ currentPassword }` only, and the web store routes those tiers to `mintStepUpGrant` (`apps/web/src/stores/authenticator.ts`). The plan keeps it that way.
6. **No new tenant table, no migration, no agent wire change (so no `MIN_AGENT_VERSION_*`), no new route** (so `apps/api/src/__tests__/mcp-coverage.test.ts` is unaffected). **Mobile: no change.** `apps/mobile` registers through the login-time `authenticatorRegisterGrantId` (`mintLoginRegisterGrant`) and never calls `register-grant` (see `apps/mobile/src/navigation/approverBannerCopy.ts`). If a table ever does appear while implementing, stop: it needs a tenancy shape, every registration in `docs/agents/tenancy-rls.md`, and a migration slot after the newest committed file (re-check it on fresh `origin/main`).

## Global Constraints

- The stronger-factor gate (`userHasStrongerReauthFactor`) runs **first**, before either proof is read or a grant is consumed. Its 403 body stays `{ error: 'stronger_factor_required' }`.
- The password road stays byte-for-byte the historical path apart from the status: the same `requireCurrentPasswordStepUp`, the same limiter key prefix `authenticator:pwd` (5 per 5 min). When both fields are sent, the password wins, and a bad password never falls back to SSO.
- The SSO road is passwordless-only and is enforced by `resolveEnrollmentStepUp`. No new eligibility logic goes in the route.
- The SSO road is **not** charged the `authenticator:pwd` limiter. Its throttle is upstream: `/sso/reauth/start` allows 5 per 15 min (`sso:reauth:<userId>`), and each grant is single-use with nothing verified after the exchange, so there is nothing to guess. Do not claim the password bucket covers it.
- Every body-proof rejection from this route answers **400** (`rejectionStatus: 400`). 429, 503 and the 403 are unchanged.
- Never log or audit a grant value; only `hadGrantId: boolean`.
- `ssoReauthGrantId` schema: `z.string().min(1).max(128).optional()` (same bound as `registerGrantIdSchema`).
- Web: mutations through `runAction`; new interactive elements get `data-testid`; every new `settings` key lands in all **8** locales (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`), enforced by `apps/web/src/lib/i18n/localeParity.test.ts`.
- Clients branch on `code` (or the literal `error` token for `enrollment_proof_required`, which carries no `code`), never on human text.

## Review Focus

1. **Grant from a different tab or session.** A user who completes the IdP trip in tab A and registers in tab B, or after a token refresh that changed `sid`, gets `400 enrollment_grant_expired` with `reauthUrl`, and the UI offers "Verify again", not "session expired". Pinned in Task 1 (bind mismatch → expired body) and Task 3 (`mapRegisterError`).
2. **Spent grant still advertised.** After an approver registration, the MFA cards must not still think an SSO grant is available, and vice versa. The section clears the parent's grant **when it submits** (the exchange consumes it whatever happens afterwards, including a cancelled WebAuthn prompt). Pinned in Task 4.
3. **Return with storage blocked.** `takeSsoReauthIntent()` returns `null` in private mode, and `null` keeps the historical TOTP road (`/mfa/setup`). A user who started from the approver section lands on TOTP setup. That is accepted (pre-existing fallback). The test asserts the `approver_device` intent does **not** call `/mfa/setup`. Pinned in Task 4.
4. **Account gains a password between start and register.** The callback already refuses (`password_set`). If the password is set after the callback, the exchange answers `400 invalid_credentials` (the resolver refuses the SSO road for a hashed account) and the grant is not consumed. Pinned in Task 1.
5. **Label typed before the IdP trip is lost** (full-page navigation). Accepted, and the label defaults to `'This device'`. The `sso` tier renders the verify step **above** the label input so the order reads correctly. Pinned in Task 2's render test.

---

## PR split and file ownership

| PR | Tasks | Files (exclusive) |
|---|---|---|
| **PR 1 — API** `fix(api): SSO re-auth road for approver-device register-grant (#9007)` | 1 | `apps/api/src/routes/authenticator.ts`, `apps/api/src/routes/authenticator.test.ts`, `apps/api/src/routes/authenticator.registerGrantSso.test.ts` (new), `apps/api/src/routes/auth/helpers.ts` (doc comments only), `apps/api/src/services/mfaStepUpGrant.ts` (doc comment only) |
| **PR 2 — web** `feat(web): verify with your identity provider to register an approver device (#9007)` | 2, 3, 4 | `apps/web/src/components/settings/StepUpPrompt.tsx` (+test), `apps/web/src/stores/authenticator.ts` (+test), `apps/web/src/components/settings/ApproverDevicesSection.tsx` (+test), `apps/web/src/lib/ssoReauthIntent.ts` (+test), `apps/web/src/components/settings/ProfilePage.tsx`, `apps/web/src/components/settings/ProfilePage.approverSsoReauth.test.tsx` (new), `apps/web/src/locales/*/settings.json` (8 files) |

PR 2 branches from `main` **after PR 1 merges** (a PR stacked on a non-main base runs no CI). PR 2 body: `Closes #9007`, `Refs #8862`. PR 1 body: `Refs #9007` (the issue is not fixed until the UI ships).

---

### Task 1: `register-grant` accepts an SSO re-auth grant (PR 1)

**Files:**
- Modify: `apps/api/src/routes/authenticator.ts` (`registerGrantMintSchema` ~L80; handler ~L201-271; header comment ~L195-198)
- Modify: `apps/api/src/routes/auth/helpers.ts` (the `resolveEnrollmentStepUp` doc block ~L555-605: the "installs a FIRST factor and nothing else" sentence ~L564 and the purpose-selection note ~L558-570. Add "or exchanged once at `POST /authenticator/register-grant` for a `register_approver_device` grant")
- Modify: `apps/api/src/services/mfaStepUpGrant.ts` (header "Minted by FOUR sources" list ~L8-14: note that the SSO re-auth grant can now also be exchanged at `register-grant`. The `register-grant` bullet there becomes "password proof or SSO re-auth grant")
- Test: `apps/api/src/routes/authenticator.test.ts` (`describe('POST /register-grant')` ~L886)
- Create: `apps/api/src/routes/authenticator.registerGrantSso.test.ts`

**Interfaces:**
- Consumes: `resolveEnrollmentStepUp(c, auth, { currentPassword?, ssoReauthGrantId? }, { keyPrefix, consume, rejectionStatus })` from `./auth/helpers` (unchanged signature); `ENROLLMENT_GRANT_EXPIRED_CODE = 'enrollment_grant_expired'`.
- Produces (wire contract PR 2 relies on), for `POST /authenticator/register-grant` with body `{ currentPassword?: string; ssoReauthGrantId?: string }`:

  | Condition | Status | Body |
  |---|---|---|
  | success (either road) | 200 | `{ registerGrantId }` |
  | TOTP/passkey held | 403 | `{ error: 'stronger_factor_required' }` |
  | wrong password; or password account sent a grant or nothing; or passwordless account sent a password | 400 | `{ error: 'Invalid credentials', message: 'Invalid credentials', code: 'invalid_credentials' }` |
  | passwordless, no proof | 400 | `{ error: 'enrollment_proof_required', reauthUrl: '/sso/reauth/start' }` |
  | passwordless, dead/expired/mismatched/spent grant | 400 | `{ error, message: 'Your identity verification has expired. Please verify with your identity provider again.', code: 'enrollment_grant_expired', reauthUrl: '/sso/reauth/start' }` |
  | throttled / Redis or epochs down | 429 / 503 | unchanged |

- Audit: `auth.authenticator.register_grant.minted` `details.method` is `'password'` or `'sso_reauth'` (whichever field drove the road; password wins when both are sent). New `auth.authenticator.register_grant.denied` with `reason: 'sso_reauth_rejected'`, `details: { hadGrantId: true }` when a grant was presented, no password was sent, and the resolver returned an error. The existing `stronger_factor_required` denial is unchanged.

- [ ] **Step 1: Write the failing route tests** in `authenticator.test.ts` (helpers are mocked there; add `resolveEnrollmentStepUp: vi.fn()` to the `vi.mock('./auth/helpers', …)` factory at ~L143 and stop asserting on `requireCurrentPasswordStepUp` in this describe):
  - `'password road: calls resolveEnrollmentStepUp with consume + 400 + authenticator:pwd'`: `expect(helperMocks.resolveEnrollmentStepUp).toHaveBeenCalledWith(expect.anything(), expect.anything(), { currentPassword: 'hunter2!' }, { keyPrefix: 'authenticator:pwd', consume: true, rejectionStatus: 400 })`; 200 `{ registerGrantId: 'grant-uuid' }`; minted audit `details: { method: 'password' }`.
  - `'sso road: ssoReauthGrantId alone mints and audits method sso_reauth'`: body `{ ssoReauthGrantId: 'sso-grant' }` → resolver called with `{ ssoReauthGrantId: 'sso-grant' }`; `mintStepUpGrant` called with `objectContaining({ operation: 'register_approver_device', sid: <test sid> })`; audit `details: { method: 'sso_reauth' }`.
  - `'stronger factor 403s before the resolver runs'`: `userHasStrongerReauthFactor → true`, body `{ ssoReauthGrantId: 'g' }` → 403, `resolveEnrollmentStepUp` **not** called.
  - `'resolver rejection is returned verbatim and nothing is minted'`: resolver returns `c.json({ error: 'enrollment_proof_required', reauthUrl: '/sso/reauth/start' }, 400)` → 400 with that exact body; `mintStepUpGrant` not called.
  - `'sso rejection is audited without the grant value'`: body `{ ssoReauthGrantId: 'secret-grant' }`, resolver returns a 400 → `writeAuthAudit` called with `objectContaining({ action: 'auth.authenticator.register_grant.denied', reason: 'sso_reauth_rejected', details: { hadGrantId: true } })`, and `JSON.stringify(writeAuthAudit.mock.calls)` does not contain `'secret-grant'`.
  - `'empty body reaches the resolver (no zod 400)'`: body `{}` → resolver called with `{}`.
  - `'ssoReauthGrantId over 128 chars is a 400 validation error before any gate'`: `'x'.repeat(129)` → 400; `userHasStrongerReauthFactor` not called.
  - Update `'propagates password step-up failures'` so the resolver returns a 400 → expect 400.

- [ ] **Step 2: Write the failing unmocked-resolver test** `authenticator.registerGrantSso.test.ts`. Mount `authenticatorRoutes` with the **real** `./auth/helpers` and mock only its collaborators: `../services/mfaStepUpGrant` (`consumeStepUpGrant`, `validateStepUpGrant`, `mintStepUpGrant`), the `../services` barrel (`getUserEpochs`, `getRedis`, `rateLimiter`, `verifyPassword`. Both `authenticator.ts` and `auth/helpers.ts` import from the barrel, so mocking `../services/authEpochs` would not intercept them. See `vi.mock('../../services', …)` in `helpers.enrollmentStepUp.test.ts` ~L67), the `db` select for `users.passwordHash`, the passkey/mfa row read by `userIsMfaProtected` / `userHasStrongerReauthFactor`, `authMiddleware` (sets `auth.user.id = USER_ID`, `auth.token.sid = SID`), `getRedis`, `writeAuthAudit`. Mirror the mock style in `apps/api/src/routes/auth/helpers.enrollmentStepUp.test.ts`. Tests:
  - `'no factor: consumes an enroll_first_factor grant bound to the live sid/epochs, then mints register_approver_device'`: `consumeStepUpGrant` called with `('sso-grant', { userId: USER_ID, operation: 'enroll_first_factor', authEpoch: 1, mfaEpoch: 2, sid: SID })`, **before** `mintStepUpGrant` (`invocationCallOrder`), and `mintStepUpGrant` called with `{ userId: USER_ID, operation: 'register_approver_device', authEpoch: 1, mfaEpoch: 2, sid: SID }`.
  - `'SMS-only passwordless: expects sso_reauth_manage_factor'`: `mfaEnabled: true, mfaMethod: 'sms'`, 0 passkeys → consume bind `operation: 'sso_reauth_manage_factor'`; 200.
  - `'consume false → 400 enrollment_grant_expired with reauthUrl, nothing minted'`.
  - `'password account offering only a grant → 400 invalid_credentials, grant NOT consumed'`.
  - `'passwordless, no proof → 400 enrollment_proof_required + reauthUrl'`.
  - `'a register_approver_device grant id presented as ssoReauthGrantId is refused'`: `consumeStepUpGrant` mock implements `bindsMatch` on `operation` (stores one record with `operation: 'register_approver_device'`) → 400 `enrollment_grant_expired`.

- [ ] **Step 3: Run both files; verify they fail**

  Run: `cd apps/api && npx vitest run src/routes/authenticator.test.ts src/routes/authenticator.registerGrantSso.test.ts`
  Expected: FAIL. The schema rejects `{ ssoReauthGrantId }` / `{}` with a zod 400, and `resolveEnrollmentStepUp` is never called.

- [ ] **Step 4: Implement.** In `authenticator.ts`, change `registerGrantMintSchema` to `z.object({ currentPassword: z.string().min(1).max(256).optional(), ssoReauthGrantId: z.string().min(1).max(128).optional() })`. In the handler, keep the stronger-factor block first. Replace the `requireCurrentPasswordStepUp` call with `resolveEnrollmentStepUp(c, auth, { currentPassword, ssoReauthGrantId }, { keyPrefix: 'authenticator:pwd', consume: true, rejectionStatus: 400 })`. On error, write the `sso_reauth_rejected` denial when `!currentPassword && ssoReauthGrantId`, then return the error. Set `method = currentPassword ? 'password' : 'sso_reauth'` for the minted audit. Drop the now-unused `requireCurrentPasswordStepUp` import if nothing else uses it. Rewrite the header comment above the route: two roads, stronger factor first, 400 per #4470, and the exchange policy from Decision 1. Update the doc comments in `helpers.ts` and `mfaStepUpGrant.ts` listed under Files.

- [ ] **Step 5: Run; verify pass, plus the neighbours that share the helpers**

  Run: `cd apps/api && npx vitest run src/routes/authenticator.test.ts src/routes/authenticator.registerGrantSso.test.ts src/routes/auth/helpers.enrollmentStepUp.test.ts src/routes/auth/helpers.registerStepUp.test.ts src/routes/sso.reauth.test.ts`
  Expected: all PASS. Then typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit; echo "tsc exit=$?"`. Expected: `tsc exit=0` (read the exit code; never pipe to `tail`).

- [ ] **Step 6: Commit**

  ```bash
  git add apps/api/src/routes/authenticator.ts apps/api/src/routes/authenticator.test.ts apps/api/src/routes/authenticator.registerGrantSso.test.ts apps/api/src/routes/auth/helpers.ts apps/api/src/services/mfaStepUpGrant.ts
  git commit -m "fix(api): register-grant accepts an SSO re-auth grant for passwordless accounts (#9007)"
  ```

---

### Task 2: `sso` re-auth tier and its prompt (PR 2)

**Files:**
- Modify: `apps/web/src/components/settings/StepUpPrompt.tsx`
- Test: `apps/web/src/components/settings/StepUpPrompt.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json` (`stepUpPrompt` block)

**Interfaces:**
- Produces:
  - `export type ReauthTier = 'passkey' | 'totp' | 'sso' | 'password'`
  - `pickReauthTier(passkeyCount: number, mfaMethod: string | null, hasPassword?: boolean): ReauthTier`. It returns `'sso'` only when `hasPassword === false` and the result would otherwise be `'password'`. `undefined` (unknown) keeps `'password'`, the same fail-safe as `ProfilePage.noPasswordChange`. ProfilePage's existing `passkeyStepUpTier` call stays two-argument and is unaffected.
  - `StepUpPrompt` props add `sso?: { verified: boolean; starting: boolean; onStart: () => void }`, used only when `tier === 'sso'`.
- New `settings.stepUpPrompt` keys (en copy fixed here):
  - `ssoVerifyFirst`: "This account signs in through your identity provider and has no password. Verify with your provider first, then register this device."
  - `verifyWithYourIdentityProvider`: "Verify with your identity provider"
  - `ssoVerified`: "Identity verified. Register this device within 5 minutes."

- [ ] **Step 1: Write failing tests** in `StepUpPrompt.test.tsx`:
  - `pickReauthTier(0, null, false) === 'sso'`; `pickReauthTier(0, 'sms', false) === 'sso'`; `pickReauthTier(1, null, false) === 'passkey'`; `pickReauthTier(0, 'totp', false) === 'totp'`; `pickReauthTier(0, null, true) === 'password'`; `pickReauthTier(0, null) === 'password'`.
  - `tier="sso"` with `sso.verified=false` renders `data-testid="approver-stepup-sso-start"` (a button, label `verifyWithYourIdentityProvider`); clicking it calls `onStart` once; `starting=true` disables it; no `approver-stepup-password` input is rendered.
  - `tier="sso"` with `verified=true` renders `data-testid="approver-stepup-sso-verified"` and no start button.

- [ ] **Step 2: Run; verify fail**

  Run: `cd apps/web && npx vitest run src/components/settings/StepUpPrompt.test.tsx`
  Expected: FAIL (`'sso'` is not a tier; testids absent).

- [ ] **Step 3: Implement** the tier and the `sso` branch in `StepUpPrompt.tsx`. Add the three keys to all 8 locale files: real translations in each locale, matching the tone of the existing `profilePage.verifyWithYourIdentityProvider` translations already present in that locale's file. Update the `pickReauthTier` doc comment: `sso` mirrors the server's passwordless road and never outranks a stronger factor.

- [ ] **Step 4: Run; verify pass**

  Run: `cd apps/web && npx vitest run src/components/settings/StepUpPrompt.test.tsx src/lib/i18n/localeParity.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(web): sso re-auth tier for approver-device registration (#9007)"` (stage the tsx, test, and 8 locale files).

---

### Task 3: store and error mapping for the SSO road (PR 2)

**Files:**
- Modify: `apps/web/src/stores/authenticator.ts` (`RegisterReauth` ~L55, `mintRegisterGrant` ~L102)
- Test: `apps/web/src/stores/authenticator.test.ts`
- Modify: `apps/web/src/components/settings/ApproverDevicesSection.tsx` (`mapRegisterError` only, ~L107-158)
- Test: `apps/web/src/components/settings/ApproverDevicesSection.test.tsx`
- Modify: 8 × `settings.json` (`approverDevicesSection` block)

**Interfaces:**
- Consumes: Task 1 wire contract.
- Produces: `RegisterReauth` adds `| { method: 'sso'; ssoReauthGrantId: string }`. `RegisterStepError` already carries `status` + `code`. For `enrollment_proof_required` the store sets `message = data.error` (the literal token).
- New `settings.approverDevicesSection` key: `ssoVerificationExpired`: "Your identity provider verification has expired or was already used. Verify again to register this device."

- [ ] **Step 1: Write failing tests.**
  - Store: `'sso path: posts { ssoReauthGrantId } to /authenticator/register-grant with skipUnauthorizedRetry, then threads registerGrantId to options+verify'`. Assert the first call's URL contains `/authenticator/register-grant`, `JSON.parse(body)` equals `{ ssoReauthGrantId: 'sso-g' }` (no `currentPassword` key), the init has `skipUnauthorizedRetry: true`, and the options/verify bodies carry the minted `registerGrantId`.
  - Store: `'sso path: 400 enrollment_grant_expired rejects with status 400 and code'`.
  - Section (`mapRegisterError` through a rendered register attempt with `registerApproverDevice` mocked to throw):
    - `{ status: 400, code: 'enrollment_grant_expired' }` → toast `ssoVerificationExpired`.
    - `{ status: 400, message: 'enrollment_proof_required' }` → same toast.
    - `{ status: 400, code: 'invalid_credentials' }` on the password tier → `incorrectPassword` (unchanged).
    - `{ status: 401, message: 'Invalid or expired token' }` → `sessionExpiredReloadAndTryAgain` (unchanged).

- [ ] **Step 2: Run; verify fail**

  Run: `cd apps/web && npx vitest run src/stores/authenticator.test.ts src/components/settings/ApproverDevicesSection.test.tsx`
  Expected: FAIL.

- [ ] **Step 3: Implement.** Add the `sso` branch to `mintRegisterGrant`, same `fetchWithAuth` call and `skipUnauthorizedRetry: true` as the password branch, body `{ ssoReauthGrantId }`. In `mapRegisterError`, check `code === 'enrollment_grant_expired' || err.message === 'enrollment_proof_required'` before `isProofRejection`, and return `ssoVerificationExpired`. Remove the legacy `status === 401 && message === 'Invalid credentials'` arm and its comment: after Task 1 the route answers 400, and API and web ship in the same image. Add the key to all 8 locales.

- [ ] **Step 4: Run; verify pass** — same command plus `src/lib/i18n/localeParity.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(web): store + error mapping for SSO approver register grant (#9007)"`.

---

### Task 4: wire the round-trip through ProfilePage (PR 2)

**Files:**
- Modify: `apps/web/src/lib/ssoReauthIntent.ts` (`SsoReauthIntent`, `INTENTS`, doc comment)
- Test: `apps/web/src/lib/ssoReauthIntent.test.ts`
- Modify: `apps/web/src/components/settings/ApproverDevicesSection.tsx` (props, tier, `buildReauth`, submit)
- Test: `apps/web/src/components/settings/ApproverDevicesSection.test.tsx`
- Modify: `apps/web/src/components/settings/ProfilePage.tsx` (mount effect ~L598-640; `<ApproverDevicesSection …>` ~L1871)
- Create: `apps/web/src/components/settings/ProfilePage.approverSsoReauth.test.tsx` (copy the harness of `ProfilePage.ssoFactorManagement.test.tsx`)

**Interfaces:**
- Consumes: Task 2 (`pickReauthTier(…, hasPassword)`, `StepUpPrompt` `sso` prop), Task 3 (`RegisterReauth` `sso`).
- Produces:
  - `SsoReauthIntent` adds `'approver_device'`.
  - `ApproverDevicesSection` props become `{ passkeyCount: number; mfaMethod: string | null; hasPassword?: boolean; ssoReauthGrantId?: string | null; isStartingSsoReauth?: boolean; onStartSsoReauth?: () => void; onSsoReauthGrantSpent?: () => void; landOnRegister?: boolean }`.
  - ProfilePage passes `hasPassword={user?.hasPassword}`, `ssoReauthGrantId`, `isStartingSsoReauth`, `onStartSsoReauth={() => handleSsoReauthStart('approver_device')}`, `onSsoReauthGrantSpent={() => setSsoReauthGrantId(null)}`, `landOnRegister={approverReauthReturn}`.

- [ ] **Step 1: Write failing tests.**
  - `ssoReauthIntent.test.ts`: `stashSsoReauthIntent('approver_device')` then `takeSsoReauthIntent() === 'approver_device'`, and the key is removed afterwards.
  - `ApproverDevicesSection.test.tsx`:
    - `hasPassword={false}`, no grant: renders `approver-stepup-sso-start`, register button `approver-device-register` disabled; clicking start calls `onStartSsoReauth`.
    - `hasPassword={false}`, `ssoReauthGrantId="sso-g"`: register enabled; clicking it calls `onSsoReauthGrantSpent` **before** `registerApproverDevice` resolves (use a pending promise), and `registerApproverDevice` gets `(label, { method: 'sso', ssoReauthGrantId: 'sso-g' })`.
    - `hasPassword={false}` with `passkeyCount={1}`: passkey tier, no SSO button (stronger factor outranks).
    - Verify step renders above `approver-device-label-input` in DOM order (Review Focus 5).
  - `ProfilePage.approverSsoReauth.test.tsx`:
    - `window.location.hash = '#ssoReauthGrant=sso-g'`, sessionStorage intent `approver_device`, `/users/me` returns `hasPassword: false`: `callsTo('/auth/mfa/setup')` has length 0 (same helper as `ProfilePage.ssoFactorManagement.test.tsx`); `approver-stepup-sso-verified` is rendered; the hash is stripped.
    - Clicking `approver-stepup-sso-start` POSTs `/sso/reauth/start` and stashes `approver_device` before `window.location.assign`.
    - After a successful register, the MFA card no longer reports a grant (`ssoReauthGrantAvailable` false). Assert the MFA settings' "verify with your identity provider" affordance is shown again.

- [ ] **Step 2: Run; verify fail**

  Run: `cd apps/web && npx vitest run src/lib/ssoReauthIntent.test.ts src/components/settings/ApproverDevicesSection.test.tsx src/components/settings/ProfilePage.approverSsoReauth.test.tsx`
  Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Intent: add `'approver_device'` to the type and to `INTENTS`. Update the doc comment: the grant that comes back is the same `enroll_first_factor` / `sso_reauth_manage_factor`, and the approver section exchanges it at `register-grant`.
  - ProfilePage mount effect: an `approver_device` branch sets the grant, sets `approverReauthReturn = true` and returns. **No** `/mfa/setup`.
  - Landing: reuse the passkey-card callback-ref pattern (`passkeyCardRef`). Pass `landOnRegister`; the section scrolls its register block into view once and focuses the register button.
  - Section: `tier = pickReauthTier(passkeyCount, mfaMethod, hasPassword)`. `buildReauth()` returns `{ method: 'sso', ssoReauthGrantId }` when `tier === 'sso' && ssoReauthGrantId`, else `null` for `sso`. `handleRegister` calls `onSsoReauthGrantSpent?.()` immediately before `registerApproverDevice` when the tier is `sso`. The whole submit stays inside `runAction`, as today.

- [ ] **Step 4: Run; verify pass, plus the profile neighbours that share the grant state**

  Run: `cd apps/web && npx vitest run src/lib/ssoReauthIntent.test.ts src/components/settings/ApproverDevicesSection.test.tsx src/components/settings/ProfilePage.approverSsoReauth.test.tsx src/components/settings/ProfilePage.ssoFactorManagement.test.tsx src/components/settings/ProfilePage.mfaEnrollment.test.tsx src/components/settings/ProfilePage.passkeys.test.tsx src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n/localeParity.test.ts`
  Expected: PASS. Typecheck as CI does (`.github/workflows/ci.yml` typecheck job): `cd apps/web && NODE_OPTIONS=--max-old-space-size=12288 pnpm exec astro check; echo "astro exit=$?"` → `astro exit=0`.

- [ ] **Step 5: Commit** — `git commit -m "feat(web): approver-device SSO re-auth round-trip from Profile (#9007)"`.

---

## Contract tests and CI that fire

- `test-api`: the auth route tests above. `mcp-coverage.test.ts` does not fire (no route added). `migrationRlsScope` / check-migrations do not fire (no migration).
- `test-web`: `no-silent-mutations.test.ts` (new submit stays in `runAction`), `localeParity.test.ts` (8 locales), `humanizedKeyRegression.test.ts` if the key names trip its baseline (use descriptive camelCase as above).
- Integration Tests (16 shards): nothing tenancy-related changes. They still run on the PR, and `pnpm test` does not run them locally. No local test stack is required for this plan (no RLS/cascade surface touched).

## Exit checklist (per PR)

- [ ] Every new test was seen failing before the implementation (paste the red run's failing-test names in the PR body).
- [ ] Scoped vitest runs above green; `tsc --noEmit` exit 0 read directly (12 GB heap).
- [ ] PR 1: `grep -n "requireCurrentPasswordStepUp" apps/api/src/routes/authenticator.ts` returns nothing, or only a deliberate remaining use.
- [ ] PR 1: no grant value in any audit/log line (`authenticator.test.ts` `'sso rejection is audited without the grant value'`).
- [ ] PR 2: all 8 `settings.json` files carry the 4 new keys; no `en` text copied into other locales.
- [ ] PR 2: manual check on a worktree stack with an OIDC provider, if one is available. Passwordless no-factor user → Approval security → Verify → IdP → back on the register block → Register → Touch ID/Hello → device listed. Otherwise state in the PR that the IdP leg is covered by `sso.reauth.test.ts` only, and list it as an owed lab check.
- [ ] PR body: Decision 4 (TTL not capped) listed as a Todd decision; out-of-scope items listed with their tracking.
- [ ] One independent review round (auth surface: full rigor).

## Decisions and follow-ups for Todd

1. **TTL across the exchange is not capped** (worst case about 10 min from IdP `auth_time` to WebAuthn verify). Default: accept. Alternative: store the SSO grant's mint time and cap the register grant's TTL at the remainder.
2. **`register-grant` moves from 401 to 400** for rejected proofs (#4470 direction). Default: do it in PR 1 (no mobile caller; current web already handles 400).
3. **Candidate follow-up issues** (not filed by this plan):
   - "Set a password" for passwordless accounts behind an SSO re-auth grant (the open half of #9008).
   - SSO-required org users who still hold a password hash keep the password road for register-grant and step-ups.
   - #4470 400 migration for the remaining 401-default step-up callers (approvals/PAM, email change).
4. **#8862 closure:** the `exp` part needs the Entra reporter's retest on a build with #8974. #9008 is closed. #9007 closes with PR 2.
