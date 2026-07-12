# Wave 2 Task 4 Report — Purpose-Bound Existing-Factor Step-Up

## Delivery

- Branch: `fix/core-mfa-policy-assurance`
- Exact base/starting HEAD: `bb763573ef8cb62a69ce4bd315ad19e5372b2973`
- Node: repository-pinned `v22.20.0`
- pnpm: `10.33.4`
- Scope: Wave 2 Task 4 authorization only. Task 5 still owns factor-mutation `mfa_epoch` advancement, refresh-family invalidation, current-session reauthentication, and remote-session teardown. Task 6 recovery login remains deferred.

## Grant schema and storage

The helper exports `issueMfaStepUpGrant`, `readMfaStepUpGrant`, and `consumeMfaStepUpGrant`. The opaque returned bearer value contains 32 random bytes (256 bits) encoded as base64url. Redis never uses that raw value as a key; the only key reference is:

```text
auth:mfa-step-up-grant:<sha256(raw grant)>
```

The value is strict versioned JSON with exactly these fields:

```ts
type MfaStepUpGrantRecord = {
  version: 1;
  purpose: 'passkey.register' | 'totp.replace' | 'sms.replace' | 'email.change';
  userId: string;
  sessionId: string; // access-token sid / durable family
  authEpoch: number;
  mfaEpoch: number;
  verifiedMethod: 'totp' | 'sms' | 'passkey';
  issuedAt: string;
  expiresAt: string;
};
```

The Redis TTL is exactly five minutes, and the canonical timestamps must also be exactly five minutes apart. Missing, expired, legacy-version, partial, malformed, unknown-field, wrong-purpose, wrong-user, wrong-session, wrong-epoch, or wrong-method records fail closed. Redis absence and command errors produce an unavailable error rather than a bypass. Raw grants, grant hashes, codes, assertions, and challenge material are not logged or audited.

`readMfaStepUpGrant` validates a reference without consuming it for registration-options binding. `consumeMfaStepUpGrant` first validates the expected binding, then atomically `GETDEL`s and compares the exact consumed record with the previously read record. Absence, replay, mutation between read/consume, or any binding mismatch rejects and never inserts a credential.

## Existing-factor proof endpoint flow

### `POST /auth/mfa/step-up/options`

1. Requires an authenticated access session and a schema-valid purpose/method.
2. Acquires the shared lock order through the existing assurance primitives: partner MFA-policy advisory lock, user row, then passkey/factor rows.
3. Requires the user status and live `auth_epoch`/`mfa_epoch` to match the access token's `ae`/`me` and resolves the effective policy through the same transaction.
4. Treats TOTP, configured verified SMS, and active passkeys as existing factors. A factor must also remain allowed by live policy. Recovery codes are not accepted as enrollment proof.
5. TOTP returns readiness, SMS sends through the existing Twilio Verify primitive, and passkey generates a dedicated `step-up-authentication` WebAuthn challenge bound to the requested operation purpose. Options issuance is rate-limited.

### `POST /auth/mfa/step-up/verify`

1. Repeats the locked live factor/policy/epoch checks and rate limit.
2. TOTP uses the consuming verifier, SMS uses Twilio Verify, and passkey requires an already stored active credential owned by the user and consumes the dedicated assertion challenge.
3. Passkey counter/device metadata is updated after a valid assertion.
4. The route repeats the locked live factor/policy check after proof, then calls the grant issuer with the exact access `sid`, epochs, purpose, user, and proven existing method.
5. A candidate registration credential cannot prove its own addition because passkey proof looks up an active credential before any candidate insert.

## Initial versus protected passkey registration

- No existing TOTP/SMS/passkey factor: `/passkeys/register/options` requires the current password and creates an `initial-password`-bound registration challenge. It does not create or fabricate a step-up grant.
- Any existing factor, even one currently disallowed: password alone is insufficient. A currently allowed existing factor must first produce a `passkey.register` grant.
- Protected options validate but do not consume the grant. The registration challenge stores only the grant SHA-256 reference plus `passkey.register` purpose.
- Registration verify requires the same authorization kind and exact grant reference as the challenge. It verifies the candidate first, rechecks the live proven method, then atomically consumes the grant immediately before `user_passkeys` insert.
- A consumed grant cannot authorize another credential or purpose. Two candidate credentials racing on one grant have one insert winner.
- Login authentication, existing-factor step-up authentication, and new-credential registration use distinct WebAuthn challenge ceremonies/keys. All verification paths consume challenges with Redis `GETDEL`.

## RED/GREEN evidence

### Baseline

```text
helper/passkey/service/schema focused baseline
PASS — 4 files, 65/65 tests
```

### Grant RED

```text
helpers.mfaStepUp.test.ts
FAIL — 15 expected failures: issue/read/consume/hash functions did not exist
```

The cases specified 256-bit randomness, hashed-only keys, strict schema, five-minute TTL, non-consuming read, purpose/user/session/auth-epoch/MFA-epoch/method mismatch, expiration, replay, changed-record burn, Redis errors, and Redis absence.

### Passkey service RED

```text
passkeys.test.ts
FAIL — 4 expected failures
```

The old challenge record omitted authorization, accepted a different/initial authorization at verify, and reused the ordinary login-authentication ceremony for existing-passkey step-up.

### Route RED

```text
auth.passkeys targeted new contract
FAIL — 6 expected failures
```

Password-only protected registration still reached the old path, grant-bearing options were rejected by the old schema, replay inserted twice, and the TOTP/SMS/passkey proof endpoint returned 404.

### GREEN

```text
focused Task 4 gate
PASS — 4 files, 98/98 tests

broad Wave 1 / Wave 2 auth-MFA gate
PASS — 10 files, 386/386 tests
```

## Race and security evidence

- Unit grant replay and changed-record tests prove one `GETDEL` result and fail-closed burn on record drift.
- Service tests prove two existing-passkey proof verifiers racing on one challenge call the WebAuthn verifier once.
- Route tests prove two different candidate credentials racing on one grant produce statuses `[200, 401]` and exactly one credential insert.
- Candidate-self-proof is explicitly denied when the asserted credential is not already stored and active.
- A factor that is enrolled but newly disallowed by live policy cannot verify or mint a grant.
- Grant options do not call `GETDEL`; registration verification does, and invocation ordering proves it occurs before the insert.
- Real Redis 7 proof used the repository test container and temporary integration harness: the hashed-only key had TTL at least 298 seconds; 12 concurrent consumers produced exactly one fulfillment and 11 rejections; the key was absent afterward. The temporary harness was removed after the successful run.

## Verification gates

```text
real Redis atomicity
PASS — 2/2 tests (existing pending-MFA case plus temporary step-up case)

corepack pnpm --dir apps/api exec tsc --noEmit -p tsconfig.json --pretty false
PASS

corepack pnpm --filter @breeze/api lint
PASS

corepack pnpm --filter @breeze/api build
PASS (existing import.meta/CJS warning only)

git diff --check
PASS
```

The first build attempt exposed a services-barrel import that tests had mocked. Root-cause comparison with the existing middleware/login pattern showed `mfaPolicy` is intentionally imported directly. The route now uses that direct module boundary; the immediate build rerun passed.

## Changed files

- `apps/api/src/routes/auth/helpers.ts`
- `apps/api/src/routes/auth/helpers.mfaStepUp.test.ts`
- `apps/api/src/routes/auth/passkeys.ts`
- `apps/api/src/routes/auth.passkeys.test.ts`
- `apps/api/src/routes/auth/schemas.ts`
- `apps/api/src/routes/auth/schemas.test.ts`
- `apps/api/src/services/passkeys.ts`
- `apps/api/src/services/passkeys.test.ts`
- `.superpowers/sdd/wave2-task-4-report.md`

No migration, schema table, RLS policy, tenant allowlist, factor epoch mutation, session-family invalidation, recovery-code login, or client UI contract was added in Task 4.

## Deferred to Task 5

Task 4 authorizes protected factor enrollment and preserves the shared MFA lock-order contract. Task 5 must still make the successful factor mutation itself transactional: advance `mfa_epoch`, revoke every refresh family, return `reauthenticate: true`, invalidate the current browser session, and perform post-commit remote-session teardown. A consumed authorization is intentionally not restored if the subsequent mutation fails.
