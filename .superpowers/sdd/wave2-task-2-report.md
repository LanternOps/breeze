# Wave 2 Task 2 Report — AMR-Bound Sessions

## Delivery

- Branch: `fix/core-mfa-policy-assurance`
- Starting HEAD: `a0110bd286de155eafbdd40947a22bcd11d54774`
- Commit: delivered by the commit containing this report
- Scope: Wave 2 Task 2 only. Pending-login V2 storage, factor consumption, and policy/factor mutation invalidation remain assigned to later tasks.

## Implemented behavior

- Added a required, strictly validated `amr` claim to Breeze access and refresh tokens.
  - Supported primary methods: `password`, `sso`, `cf_access`.
  - Supported local MFA methods: `totp`, `sms`, `passkey`, `recovery_code`.
  - Validation rejects missing, empty, unknown, duplicate, multi-primary, multi-local, and `mfa`-inconsistent claims at both signing and verification boundaries.
- Bound session issuance to the authentication methods actually verified.
  - Password, invite, and registration sessions issue `['password']` with `mfa: false`.
  - TOTP, SMS, and passkey completions preserve the pending primary method and append only the verified local method.
  - SSO and Cloudflare Access issue their exact external primary method. They set `mfa: true` only when the configured trust setting and verified upstream assertion both support that assurance.
  - Malformed/legacy pending-login state without a valid primary AMR fails closed.
- Added live assurance evaluation against `resolveEffectiveMfaPolicy`.
  - Required MFA rejects primary-only sessions.
  - A local method must remain allowed by the current effective policy.
  - Trusted external MFA satisfies a required policy without being filtered through the local-factor allowlist.
  - Enrollment state selects the `428` enrollment response but never substitutes for authentication assurance.
- Reordered authentication middleware around live authority and policy resolution. Revocation/family checks occur before any forced-enrollment response, and tenant accessibility is checked only after assurance succeeds.
- Narrowed forced-enrollment exemptions to the exact logout, enrollment, phone-verification, and passkey-registration endpoints.
- Refresh now resolves live authority and policy before claiming/rotating the JTI, rejects stale or disallowed assurance without rotating the family, and preserves the exact signed AMR on success.
- Hardened `requireMfa` so an inconsistent legacy `mfa: true` bit without valid factor AMR is not accepted.
- Kept viewer tokens and synthetic non-JWT `AuthContext` producers isolated from the user-session AMR contract.

## Assurance matrix

| Signed evidence | `mfa` | Required policy | Result |
|---|---:|---:|---|
| `password` | false | false | Allowed |
| `password` | false | true | Rejected; enroll (`428`) only when eligible and unenrolled |
| `password` + allowed local factor | true | true | Allowed |
| `password` + now-disallowed local factor | true | either | Rejected (`403`) |
| trusted `sso` or `cf_access` assertion | true | true | Allowed |
| untrusted `sso` or `cf_access` assertion | false | true | Rejected |
| external primary + allowed verified local factor | true | true | Allowed |
| malformed, missing, duplicate, or inconsistent AMR | any | any | Token/pending state rejected |

## Issuer inventory

All first-party user-session issuers funnel through `issueUserSession` and provide explicit AMR:

- `apps/api/src/middleware/cfAccessLogin.ts`
- `apps/api/src/routes/auth/cfAccessRedirectLogin.ts`
- `apps/api/src/routes/auth/invite.ts`
- `apps/api/src/routes/auth/login.ts`
- `apps/api/src/routes/auth/mfa.ts`
- `apps/api/src/routes/auth/passkeys.ts`
- `apps/api/src/routes/auth/register.ts`
- `apps/api/src/routes/sso.ts`

`userSessionCallsites.test.ts` now locks this inventory and continues to prohibit direct low-level token issuance outside approved services.

## TDD evidence

### Initial RED

```text
jwt.test.ts + userSession.test.ts + middleware/auth.test.ts
FAIL — 26 failures / 96 passes
```

The failures covered missing/malformed/duplicate/unknown/inconsistent AMR, token round trips, session forwarding, required/disallowed assurance, and trusted external MFA.

### Issuer RED

```text
Focused issuer suites
FAIL — 26 failures
```

The failures exposed issuer fixtures without AMR, legacy pending-login state, policy mock gaps, and vacuous Cloudflare MFA claims.

### Signing/order RED

```text
jwt/auth targeted: refuses to sign; sid family; revoked access tokens
FAIL — 6 failures
```

This proved signing did not yet enforce the AMR invariant and revocation ordering could be bypassed by enrollment handling.

### `requireMfa` RED

```text
auth.test.ts: inconsistent legacy mfa=true bit without factor AMR
FAIL — expected 403, received 200
```

### Final GREEN

```text
Task 2 focused suite
PASS — 13 files, 488/488 tests

refresh-token-family.integration.test.ts
PASS — 1 file, 7/7 tests (141.97s)
```

The integration test used the real integration configuration and single-worker fork pool. An earlier package-script attempt accidentally selected a broader suite and was stopped; it is not counted as verification evidence.

## Verification gates

```text
corepack pnpm --dir apps/api exec tsc --noEmit -p tsconfig.json --pretty false
PASS

corepack pnpm --filter @breeze/api lint
PASS

corepack pnpm --filter @breeze/api build
PASS (existing tsup import.meta/CJS warning only)

git diff --check
PASS
```

## Changed files

Core implementation and focused tests:

- `apps/api/src/services/jwt.ts` and `jwt.test.ts`
- `apps/api/src/services/userSession.ts` and `userSession.test.ts`
- `apps/api/src/services/userSessionCallsites.test.ts`
- `apps/api/src/services/mfaPolicy.ts` and `mfaPolicy.test.ts`
- `apps/api/src/middleware/auth.ts` and `auth.test.ts`
- `apps/api/src/middleware/cfAccessLogin.ts` and `cfAccessLogin.test.ts`
- `apps/api/src/routes/auth/login.ts` and `login.test.ts`
- `apps/api/src/routes/auth/mfa.ts`
- `apps/api/src/routes/auth/passkeys.ts` and `apps/api/src/routes/auth.passkeys.test.ts`
- `apps/api/src/routes/auth/register.ts` and `register.test.ts`
- `apps/api/src/routes/auth/invite.ts`
- `apps/api/src/routes/auth/cfAccessRedirectLogin.ts` and `cfAccessRedirectLogin.test.ts`
- `apps/api/src/routes/sso.ts` and `sso.test.ts`
- `apps/api/src/routes/auth.test.ts`
- `apps/api/src/services/featureConfigResolver.ts`

Token fixture compatibility updates:

- `apps/api/src/__tests__/helpers.ts`
- `apps/api/src/__tests__/integration/db-utils.ts`
- Fourteen integration/unit fixture files that construct signed user tokens directly, including OAuth, branding, invite, remote-session, SSO, tenant-status, time-entry, update-ring, vulnerability, and remediation-event coverage.

## Self-review

- Reviewed the final diff directly because the task explicitly prohibited subagents.
- Confirmed all production `issueUserSession` callsites are enumerated and guarded.
- Confirmed viewer tokens retain their separate contract and synthetic contexts do not invent authentication evidence.
- Confirmed revocation/family validation precedes forced enrollment and refresh claims no JTI before assurance validation.
- Confirmed enrollment state is not used as proof of MFA.
- Confirmed no migration, RLS policy, authorization axis, or secret-handling surface changed.

## Concerns / deferred work

- Task 3 owns pending-login V2 storage. This task fails legacy/malformed pending AMR closed but does not redesign persistence.
- Task 5 owns transactional epoch advancement and refresh-family revocation on factor/effective-policy mutations.
- Task 6 owns recovery-code consumption. The AMR vocabulary supports `recovery_code`, but this task does not add consumption behavior.
- API build retains the pre-existing tsup warning that `import.meta` is empty in CJS output from `src/db/seed.ts`; the build exits successfully.
