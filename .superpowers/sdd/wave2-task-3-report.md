# Wave 2 Task 3 Report — Single-Use Pending MFA V2

## Delivery

- Branch: `fix/core-mfa-policy-assurance`
- Base: `ea569a705f38404bf8d646ec8fb2ea22f8090f28`
- Commit: delivered by the commit containing this report
- Node: `v26.3.0` (project minimum `22.19`)
- pnpm: `10.33.4`
- Scope: Wave 2 Task 3 only. Purpose-bound step-up remains Task 4, mutation-time epoch/family invalidation remains Task 5, and recovery-code verification/consumption remains Task 6.

## Implemented behavior

- Added strict pending MFA V2 storage in `services/mfaAssurance.ts`.
  - Login writes only V2 JSON with a five-minute Redis TTL.
  - Reads reject legacy bare strings, V1/partial JSON, malformed JSON, noncanonical or duplicate method arrays, invalid epochs/status/authority axes/timestamps, and unknown fields.
  - Redis absence or command errors throw a typed unavailable error and fail closed.
- Bound pending authentication to the live login snapshot.
  - User ID, `auth_epoch`, `mfa_epoch`, expected active status.
  - Exact role/partner/organization/scope authority axes.
  - Exact effective required flag, policy-source set, and allowed-method set.
  - Exact enrolled-method set, including TOTP, SMS, passkey, and stored recovery-code enrollment.
  - Primary authentication method and selected local MFA method.
  - Canonical `issuedAt`/`expiresAt` timestamps separated by exactly five minutes.
- Password and Cloudflare Access login now reload active user/enrollment and live policy before creating the record. They select only a currently enrolled and allowed primary factor and return passkey/SMS presentation metadata derived from that same snapshot; Cloudflare Access binds `primaryAuthenticationMethod: 'cf_access'`.
- TOTP, SMS, passkey options/verification, and SMS-code sending use the strict shared reader. No route retains a partial/legacy pending parser.
- Added one consolidated post-factor issuer, `issueVerifiedPendingMfaSession`.
  - It is now the only first-party TOTP/SMS/passkey completion caller of `issueUserSession`.
  - It emits truthful AMR `[primaryAuthenticationMethod, verifiedMethod]`; enrollment flags never create assurance.
- Updated the explicit first-party issuer inventory so `services/mfaAssurance.ts` replaces `routes/auth/mfa.ts` and `routes/auth/passkeys.ts`.

## V2 state schema

```ts
type PendingMfaSessionV2 = {
  version: 2;
  userId: string;
  authEpoch: number;
  mfaEpoch: number;
  expectedStatus: 'active';
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
  scope: 'system' | 'partner' | 'organization';
  policyRequired: boolean;
  policySources: Array<'role' | 'partner' | 'organization'>;
  allowedMethods: Array<'totp' | 'sms' | 'passkey' | 'recovery_code'>;
  enrolledMethods: Array<'totp' | 'sms' | 'passkey' | 'recovery_code'>;
  primaryAuthenticationMethod: 'password' | 'sso' | 'cf_access';
  primaryMfaMethod: 'totp' | 'sms' | 'passkey';
  issuedAt: string;
  expiresAt: string;
};
```

Arrays are stored in a fixed canonical order. Parsing requires the exact key set, so unknown fields and shape drift fail closed.

## Consume and issuance ordering

1. Route reads and strictly validates the V2 record for presentation/rate limiting/factor selection.
2. Route verifies the TOTP, SMS, or WebAuthn factor. Failed factor verification leaves the pending login available for a legitimate retry.
3. Immediately before issuance, the consolidated issuer calls Redis `GETDEL`.
4. The consumed record must exactly equal the earlier verified record. Missing, malformed, changed, or ambiguous consumption fails closed.
5. After consumption, the issuer reloads the active user and active passkeys, validates status plus both epochs, and resolves live policy using the exact bound authority axes.
6. It compares required state, policy sources, allowed methods, enrolled methods, and configured primary MFA method byte-for-byte through canonical arrays. The verified method must remain both allowed and enrolled.
7. Only after all checks pass does it call `issueUserSession`, which performs the Wave 1 live epoch/family work and returns tokens.

Any Redis, state, authority, status, epoch, policy, or enrollment failure before step 7 creates no token, cookie, JTI, or refresh family. Consumed records are never restored.

## RED/GREEN evidence

### Baseline

```text
Wave 1/auth/MFA/passkey/policy focused baseline
PASS — 11 files, 401/401 tests
```

### State service RED

```text
mfaAssurance.test.ts
FAIL — module services/mfaAssurance did not exist
```

The failing suite specified the complete V2 record, five-minute TTL, strict legacy/V1/malformed/unknown rejection, invalid epoch/status/method/authority/expiry rejection, Redis unavailable/errors, exact comparison, and atomic two-consumer behavior.

### Consolidated issuer RED

```text
mfaAssurance targeted issuer/state-change tests
FAIL — 12 expected failures: issueVerifiedPendingMfaSession was not a function
```

The cases covered consume-before-reload/issue, consumed-record mismatch, status, password/auth epoch, MFA epoch, primary method, TOTP/passkey enrollment, required state, policy sources, allowed methods, Redis errors, and exactly-one issuer.

### Route RED

```text
auth targeted login/TOTP/consume-loss
FAIL — 2 expected failures (V2 creator/issuer not called)

passkey targeted issuer/race
FAIL — 2 expected failures (consolidated issuer not called; no single winner)

SMS send strict-reader regression
FAIL — legacy raw Redis path returned 401 instead of using the verified V2 record

Cloudflare Access pending-writer regression
FAIL — V2 creator was not called and the old middleware still wrote partial JSON
```

### GREEN

```text
mfaAssurance.test.ts
PASS — 35/35

Task 3 focused auth/assurance/issuer gate
PASS — 15 files, 476/476 tests

exact Wave 1 regression gate
PASS — 6 files, 276/276 tests
```

## Race evidence

- Unit service race: two simultaneous consolidated issuers consume the same pending token; exactly one calls `issueUserSession` and the other rejects.
- Route races:
  - TOTP: one `200` response with cookie, one `401`, no route-owned issuer call.
  - SMS: one `200` response with cookie, one `401`, no route-owned issuer call.
  - Passkey: one `200` response with cookie, one `401`, no route-owned issuer call.
- Real Redis 7 integration: a V2 record had an initial TTL of at least 298 seconds; 12 simultaneous `consumePendingMfa` calls produced exactly one record and 11 `null` results; the key was absent afterward.

The first attempt used the repository's full database integration config. Its shared `cleanupDatabase()` hook timed out at 30 seconds before the Redis assertion ran; no MFA assertion failed. A dedicated Redis-only Vitest config then ran the same real-driver proof successfully in 2.52 seconds.

## Issuer inventory

All first-party user-session issuers remain explicitly locked by `userSessionCallsites.test.ts`:

- `apps/api/src/middleware/cfAccessLogin.ts`
- `apps/api/src/routes/auth/cfAccessRedirectLogin.ts`
- `apps/api/src/routes/auth/invite.ts`
- `apps/api/src/routes/auth/login.ts`
- `apps/api/src/routes/auth/register.ts`
- `apps/api/src/routes/sso.ts`
- `apps/api/src/services/mfaAssurance.ts`

`routes/auth/mfa.ts` and `routes/auth/passkeys.ts` no longer mint sessions directly.

## Verification gates

```text
real Redis pending-MFA concurrency integration
PASS — 1/1

corepack pnpm --dir apps/api exec tsc --noEmit -p tsconfig.json --pretty false
PASS

corepack pnpm --filter @breeze/api lint
PASS

corepack pnpm --filter @breeze/api build
PASS (existing import.meta/CJS warning only)

git diff --check
PASS
```

## Changed files

- `apps/api/src/services/mfaAssurance.ts`
- `apps/api/src/services/mfaAssurance.test.ts`
- `apps/api/src/services/index.ts`
- `apps/api/src/services/userSessionCallsites.test.ts`
- `apps/api/src/routes/auth/login.ts`
- `apps/api/src/routes/auth/mfa.ts`
- `apps/api/src/routes/auth/passkeys.ts`
- `apps/api/src/routes/auth/phone.ts`
- `apps/api/src/middleware/cfAccessLogin.ts`
- `apps/api/src/middleware/cfAccessLogin.test.ts`
- `apps/api/src/routes/auth.test.ts`
- `apps/api/src/routes/auth.passkeys.test.ts`
- `apps/api/src/__tests__/integration/mfa-pending-concurrency.integration.test.ts`
- `apps/api/vitest.redis-integration.config.ts`
- `.superpowers/sdd/wave2-task-3-report.md`

## Self-review

- Reviewed the complete diff directly because the task explicitly prohibited subagents.
- Confirmed no production route reads `mfa:pending:*` directly, uses `GET` then `DEL`, parses legacy state, or calls `issueUserSession` after a local factor.
- Confirmed the consolidated issuer consumes before every database/policy reload and before any mint, and `issueUserSession` remains the sole low-level family/token boundary.
- Confirmed exact authority, epoch, status, allowed, enrolled, required, source, and primary-method comparisons occur after consumption.
- Confirmed recovery enrollment is snapshotted but no recovery-code input, verification, database consumption, AMR issuance, or audit behavior was pulled forward.
- Confirmed no migration, RLS policy, tenant allowlist, factor mutation, step-up grant, or secret/code logging surface changed.

## Concerns and deferred work

- Task 4 owns purpose-bound existing-factor step-up grants; this task does not change enrollment authorization.
- Task 5 owns transactional `mfa_epoch` advancement and refresh-family revocation for factor/effective-policy mutations. Task 3 already compares snapshots so current policy/enrollment changes fail closed during the pending window; Task 5 closes mutation races durably for issued sessions.
- Task 6 owns recovery-code verification, atomic database removal, recovery AMR, and cross-store recovery consumption. V2 records now preserve recovery enrollment for that work.
- The API build retains the pre-existing tsup warning that `import.meta` is empty in CJS output from `src/db/seed.ts`; build exits successfully.
