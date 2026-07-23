# Unified Security Devices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One WebAuthn ceremony can enroll a credential for both sign-in (`user_passkeys`) and approvals (`authenticator_devices`), presented as a single "Security devices" list, with a retrofit path for existing passkeys — per `docs/superpowers/specs/security-auth/2026-07-22-unified-security-devices-design.md`.

**Architecture:** Three independently shippable phases (one PR each). Phase 1 extends `POST /auth/mfa/step-up` to mint one grant per requested operation and teaches `POST /auth/passkeys/register/verify` to dual-write both stores transactionally. Phase 2 replaces the two profile cards with a merged `SecurityDevicesCard` and adds the dual-enroll checkbox. Phase 3 adds the `/authenticator/devices/webauthn/adopt` route (assertion-as-proof-of-possession) and its "Enable approvals" UI action. **No DB migration in any phase.**

**Tech Stack:** Hono + Zod 4 (`apps/api`), Drizzle (query-only), Redis grants (`services/mfaStepUpGrant.ts`), `@simplewebauthn` v13, React islands + Vitest/jsdom (`apps/web`), i18next (5 locales).

## Global Constraints

- **No schema migration.** Both tables already have what we need; `authenticator_devices.credentialId` is already `unique`.
- **Grant invariants (spec §2/§5):** grants stay bound to exactly ONE operation (`bindsMatch`), TTL 300 s, single-use `getdel`. `register_approver_device` is enforced by `enforceApproverRegisterStepUp` (NO bypass) on every path writing an `authenticator_devices` row. Never log grant values — only whether one was presented.
- **Epoch semantics:** `invalidateMfaAssuranceAfterFactorChange` (epoch bump + refresh-family revoke) runs for login-factor writes only. Adopt and approver-only writes never trigger it.
- **`isPlatformBound` is server-derived only:** `deviceType === 'singleDevice' && !backedUp` (mirrors `approverWebAuthn.ts:146`). Client input never sets it.
- **ENABLE_2FA:** every new `/auth/*` and `/authenticator/*` behavior sits behind the existing `ENABLE_2FA` guards already present in the modified routes; do not add new checks, do not remove existing ones.
- **i18n:** every new user-facing string is a literal `t('...')` key added to ALL FIVE locales (`en`, `fr-FR`, `de-DE`, `pt-BR`, `es-419`) in the same commit — key parity is CI-enforced.
- **Web mutations** surface outcomes (`runAction` or explicit error/success state, matching the file's existing pattern). `stores/auth.ts` and `stores/authenticator.ts` are typed service layers (already allowlisted).
- **Tests:** follow the `vi.hoisted` mock-factory harness used by the sibling test file named in each task. Run commands from the package dir (`apps/api` / `apps/web`); Node is pinned 22.20.0.
- **RLS/cascade:** no new tables → no allowlist or cascade-list changes. Do not touch `rls-coverage.integration.test.ts` or `tenantCascade.ts`.

---

## Phase 1 — API: multi-operation mint + dual-write verify (PR A)

### Task 1: `operations[]` on `POST /auth/mfa/step-up`

**Files:**
- Modify: `apps/api/src/routes/auth/schemas.ts` (the `mfaStepUpSchema` block, ~lines 120–141)
- Modify: `apps/api/src/routes/auth/mfa.ts:799-823` (grant mint + response)
- Test: `apps/api/src/routes/auth/schemas.test.ts` (schema cases)
- Test: Create `apps/api/src/routes/auth/mfa.stepUpMultiOp.test.ts`

**Interfaces:**
- Consumes: `mintStepUpGrant(bind: {userId, operation: StepUpOperation, authEpoch, mfaEpoch, sid}): Promise<string | null>` and `type StepUpOperation = 'add_factor' | 'register_approver_device'` from `apps/api/src/services/mfaStepUpGrant.ts`.
- Produces: request field `operations?: StepUpOperation[]` (1–2 entries); response `{ grants: Array<{ operation: StepUpOperation; stepUpGrantId: string }> }`, plus legacy top-level `stepUpGrantId` **only** when the request used the legacy single `operation` form. Task 2 and Phase 2/3 clients rely on `grants`.

- [ ] **Step 1: Write the failing schema tests**

Add to the `mfaStepUpSchema` describe block in `apps/api/src/routes/auth/schemas.test.ts`:

```ts
it('accepts operations[] alongside each method variant', () => {
  const parsed = mfaStepUpSchema.safeParse({
    method: 'totp',
    code: '123456',
    operations: ['add_factor', 'register_approver_device'],
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.operations).toEqual(['add_factor', 'register_approver_device']);
    // Legacy field still defaulted — the handler decides precedence.
    expect(parsed.data.operation).toBe('add_factor');
  }
});

it('rejects an empty operations array and unknown operations', () => {
  expect(mfaStepUpSchema.safeParse({ method: 'totp', code: '123456', operations: [] }).success).toBe(false);
  expect(mfaStepUpSchema.safeParse({ method: 'totp', code: '123456', operations: ['reset_password'] }).success).toBe(false);
  expect(mfaStepUpSchema.safeParse({
    method: 'totp', code: '123456',
    operations: ['add_factor', 'register_approver_device', 'add_factor'],
  }).success).toBe(false); // max 2
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/routes/auth/schemas.test.ts`
Expected: FAIL — `operations` unrecognized/stripped, first test's `toEqual` fails.

- [ ] **Step 3: Extend the schema**

In `apps/api/src/routes/auth/schemas.ts`, directly below the existing `stepUpOperation` const:

```ts
// Multi-operation mint (unified-security-devices §4.1): one factor proof may
// request 1–2 grants, one per operation. Takes precedence over the legacy
// singular `operation` when present. Each minted grant is STILL bound to
// exactly one operation — this widens how many grants a proof yields, never
// what any single grant can do.
const stepUpOperations = z
  .array(z.enum(STEP_UP_OPERATIONS))
  .min(1)
  .max(2)
  .optional();
```

Add `operations: stepUpOperations` to each of the three variants inside `mfaStepUpSchema` (totp, sms, passkey), keeping the existing `operation: stepUpOperation` field untouched.

- [ ] **Step 4: Run schema tests — pass**

Run: `cd apps/api && npx vitest run src/routes/auth/schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing handler tests**

Create `apps/api/src/routes/auth/mfa.stepUpMultiOp.test.ts`. Copy the `vi.hoisted` mock-factory harness from `apps/api/src/routes/auth/helpers.mfaStepUp.test.ts` (db select-chain mock, `getRedis`, `rateLimiter`, `consumeMFAToken`, `decryptMfaTotpSecret`, audit mock) and additionally mock `../../services/mfaStepUpGrant`:

```ts
const { mintStepUpGrant } = vi.hoisted(() => ({ mintStepUpGrant: vi.fn() }));
vi.mock('../../services/mfaStepUpGrant', () => ({ mintStepUpGrant }));
```

Drive the route through the mounted Hono app the way the file's siblings do (auth middleware mocked to inject `auth` with `user.id`, `token.sid: 'sid-1'`; `getUserEpochs` mocked to `{ authEpoch: 1, mfaEpoch: 2 }`; TOTP proof mocked valid). Tests:

```ts
it('mints one grant per requested operation, each bound to its own op', async () => {
  mintStepUpGrant.mockResolvedValueOnce('g-add').mockResolvedValueOnce('g-reg');
  const res = await postStepUp({
    method: 'totp', code: '123456',
    operations: ['add_factor', 'register_approver_device'],
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.grants).toEqual([
    { operation: 'add_factor', stepUpGrantId: 'g-add' },
    { operation: 'register_approver_device', stepUpGrantId: 'g-reg' },
  ]);
  expect(body.stepUpGrantId).toBeUndefined(); // operations-form: no legacy field
  expect(mintStepUpGrant).toHaveBeenNthCalledWith(1, expect.objectContaining({ operation: 'add_factor' }));
  expect(mintStepUpGrant).toHaveBeenNthCalledWith(2, expect.objectContaining({ operation: 'register_approver_device' }));
});

it('dedupes repeated operations', async () => {
  mintStepUpGrant.mockResolvedValueOnce('g-add');
  const res = await postStepUp({ method: 'totp', code: '123456', operations: ['add_factor', 'add_factor'] });
  // max(2) admits ['add_factor','add_factor']; the handler dedupes to one mint.
  expect((await res.json()).grants).toHaveLength(1);
  expect(mintStepUpGrant).toHaveBeenCalledTimes(1);
});

it('keeps the legacy single-operation response shape', async () => {
  mintStepUpGrant.mockResolvedValueOnce('g-legacy');
  const res = await postStepUp({ method: 'totp', code: '123456' });
  const body = await res.json();
  expect(body.stepUpGrantId).toBe('g-legacy');
  expect(body.grants).toEqual([{ operation: 'add_factor', stepUpGrantId: 'g-legacy' }]);
});

it('503s (and mints nothing further) when any mint fails', async () => {
  mintStepUpGrant.mockResolvedValueOnce('g-add').mockResolvedValueOnce(null);
  const res = await postStepUp({
    method: 'totp', code: '123456',
    operations: ['add_factor', 'register_approver_device'],
  });
  expect(res.status).toBe(503);
});
```

- [ ] **Step 6: Run to verify failure**

Run: `cd apps/api && npx vitest run src/routes/auth/mfa.stepUpMultiOp.test.ts`
Expected: FAIL — `grants` undefined in response.

- [ ] **Step 7: Implement the handler change**

In `apps/api/src/routes/auth/mfa.ts`, add `type StepUpOperation` to the existing `services/mfaStepUpGrant` import, then replace the single-mint block (currently `const grantId = await mintStepUpGrant({...}); if (!grantId) ...; return c.json({ stepUpGrantId: grantId });` plus its audit call, lines ~803–823) with:

```ts
  // Multi-op (unified-security-devices §4.1): `operations` wins over the
  // legacy `operation`; dedupe so a repeated entry can't double-mint.
  const requestedOps: StepUpOperation[] = [...new Set(body.operations ?? [body.operation])];
  const grants: Array<{ operation: StepUpOperation; stepUpGrantId: string }> = [];
  for (const operation of requestedOps) {
    const grantId = await mintStepUpGrant({
      userId: auth.user.id,
      operation,
      authEpoch: epochs.authEpoch,
      mfaEpoch: epochs.mfaEpoch,
      sid: auth.token.sid
    });
    if (!grantId) {
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }
    grants.push({ operation, stepUpGrantId: grantId });
  }

  writeAuthAudit(c, {
    orgId: auth.orgId ?? undefined,
    action: 'auth.mfa.stepup.granted',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: body.method, operations: requestedOps }
  });

  return c.json(
    body.operations
      ? { grants }
      : { stepUpGrantId: grants[0].stepUpGrantId, grants }
  );
```

- [ ] **Step 8: Run handler tests + existing step-up suites — pass**

Run: `cd apps/api && npx vitest run src/routes/auth/mfa.stepUpMultiOp.test.ts src/routes/auth/helpers.mfaStepUp.test.ts src/routes/auth/schemas.test.ts src/routes/auth/phone.test.ts`
Expected: PASS (phone.test.ts guards the legacy consumers didn't shift).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/auth/schemas.ts apps/api/src/routes/auth/schemas.test.ts apps/api/src/routes/auth/mfa.ts apps/api/src/routes/auth/mfa.stepUpMultiOp.test.ts
git commit -m "feat(auth): multi-operation step-up grant mint (unified-security-devices P1)"
```

### Task 2: Dual-write at `POST /auth/passkeys/register/verify`

**Files:**
- Modify: `apps/api/src/routes/auth/passkeys.ts` (`registerVerifySchema` ~line 70; verify handler ~lines 139–253)
- Test: Create `apps/api/src/routes/auth/passkeys.dualEnroll.test.ts`

**Interfaces:**
- Consumes: `enforceApproverRegisterStepUp(c, auth, grantId, { consume: true })` from `./helpers` (returns `Response | null`; writes the `auth.authenticator.register.denied` audit itself); `authenticatorDevices` + `type AuthenticatorDevice` from `../../db/schema`; `registrationInfoToPasskeyFields` output fields `{ credentialId, publicKey, counter, deviceType, backedUp, transports, aaguid }`.
- Produces: request fields `approverRegisterGrantId?: string`, `approverLabel?: string`; response block `approver?: { registered: boolean; isPlatformBound?: boolean; deviceId?: string; reason?: 'grant_invalid' }`. Phase 2's add flow relies on exactly these names.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/auth/passkeys.dualEnroll.test.ts`. Reuse the harness pattern of Task 1 Step 5 (hoisted mocks; mock `../../services/passkeys` so `verifyPasskeyRegistration` resolves `{ verified: true, registrationInfo: {...} }` and `registrationInfoToPasskeyFields` returns a fixed fields object; mock `../../services/mfaAssurance` so `invalidateMfaAssuranceAfterFactorChange` invokes its callback with a `tx` recording `tx.insert(...).values(...)` calls; mock `./helpers` selectively with `vi.importActual` EXCEPT `enforceExistingFactorStepUp` (resolve null) and `enforceApproverRegisterStepUp` (controllable)). Tests:

```ts
it('inserts BOTH rows in one transaction and reports the approver outcome', async () => {
  enforceApproverRegisterStepUp.mockResolvedValueOnce(null); // grant consumed OK
  fields.deviceType = 'singleDevice'; fields.backedUp = false;
  const res = await postVerify({ credential, name: 'Laptop', approverRegisterGrantId: 'g-reg' });
  const body = await res.json();
  expect(body.approver).toEqual({ registered: true, isPlatformBound: true, deviceId: expect.any(String) });
  expect(txInserts.map(i => i.table)).toEqual(['user_passkeys', 'authenticator_devices']);
  const approverValues = txInserts[1].values;
  expect(approverValues).toMatchObject({
    kind: 'webauthn_platform',
    credentialId: fields.credentialId,
    isPlatformBound: true,
    label: 'Laptop',
  });
  expect(approverValues.lastUsedAt).toBeUndefined(); // pending — deferred PoP
});

it('degrades (passkey created, approver.registered=false) when the approver grant is invalid', async () => {
  enforceApproverRegisterStepUp.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: 'register_step_up_required' }), { status: 403 }),
  );
  const res = await postVerify({ credential, name: 'Laptop', approverRegisterGrantId: 'g-bad' });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.approver).toEqual({ registered: false, reason: 'grant_invalid' });
  expect(txInserts.map(i => i.table)).toEqual(['user_passkeys']);
});

it('derives isPlatformBound=false for synced credentials', async () => {
  enforceApproverRegisterStepUp.mockResolvedValueOnce(null);
  fields.deviceType = 'multiDevice'; fields.backedUp = true;
  const body = await (await postVerify({ credential, approverRegisterGrantId: 'g-reg' })).json();
  expect(body.approver.isPlatformBound).toBe(false);
  expect(txInserts[1].values.isPlatformBound).toBe(false);
});

it('never touches the approver store when approverRegisterGrantId is absent', async () => {
  const body = await (await postVerify({ credential, name: 'Laptop' })).json();
  expect(body.approver).toBeUndefined();
  expect(enforceApproverRegisterStepUp).not.toHaveBeenCalled();
  expect(txInserts.map(i => i.table)).toEqual(['user_passkeys']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/routes/auth/passkeys.dualEnroll.test.ts`
Expected: FAIL — schema strips `approverRegisterGrantId`; no `approver` in response.

- [ ] **Step 3: Extend schema + handler**

Schema (`passkeys.ts` ~line 70):

```ts
const registerVerifySchema = z.object({
  credential: webAuthnCredentialSchema,
  name: passkeyNameSchema.optional(),
  stepUpGrantId: z.string().optional(),
  // Dual enrollment (unified-security-devices §4.2): gated by the no-bypass
  // enforceApproverRegisterStepUp, never by the add_factor gate above.
  approverRegisterGrantId: z.string().optional(),
  approverLabel: passkeyNameSchema.optional()
});
```

Handler — imports: add `authenticatorDevices` and `type AuthenticatorDevice` to the schema import, `enforceApproverRegisterStepUp` to the helpers import. After the existing `enforceExistingFactorStepUp` consume (line ~179), before the transaction:

```ts
  // Dual enrollment: consume the register_approver_device grant through the
  // full no-bypass gate BEFORE the transaction. A denial DEGRADES (the passkey
  // is still created — the user proved everything the passkey required); the
  // gate's 403 Response is discarded, but it has already written the
  // auth.authenticator.register.denied audit.
  const { approverRegisterGrantId, approverLabel } = c.req.valid('json');
  let approverOutcome:
    | { registered: true; isPlatformBound: boolean; deviceId?: string }
    | { registered: false; reason: 'grant_invalid' }
    | undefined;
  if (approverRegisterGrantId !== undefined) {
    const approverGrantError = await enforceApproverRegisterStepUp(c, auth, approverRegisterGrantId, { consume: true });
    approverOutcome = approverGrantError
      ? { registered: false, reason: 'grant_invalid' }
      : { registered: true, isPlatformBound: fields.deviceType === 'singleDevice' && !fields.backedUp };
  }
```

Inside the `invalidateMfaAssuranceAfterFactorChange` callback, immediately after the `user_passkeys` insert (`inserted = row;`):

```ts
    if (approverOutcome?.registered) {
      const [approverRow] = await tx
        .insert(authenticatorDevices)
        .values({
          userId: auth.user.id,
          kind: 'webauthn_platform',
          label: approverLabel ?? name ?? 'This device',
          publicKey: fields.publicKey,
          credentialId: fields.credentialId,
          signCount: fields.counter,
          aaguid: fields.aaguid,
          transports: (fields.transports ?? undefined) as AuthenticatorDevice['transports'],
          isPlatformBound: approverOutcome.isPlatformBound,
          // last_used_at stays at its null default — PENDING until the first
          // approval signature (deferred PoP, same as the standalone route).
        })
        .returning();
      if (!approverRow) {
        throw new Error('Approver device insert returned no row');
      }
      approverOutcome.deviceId = approverRow.id;
    }
```

After the existing success audit, add the approver audit (mirrors `routes/authenticator.ts` verify):

```ts
  if (approverOutcome?.registered) {
    writeAuthAudit(c, {
      orgId: auth.orgId ?? undefined,
      action: 'auth.authenticator.device.register',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: {
        deviceId: approverOutcome.deviceId,
        kind: 'webauthn_platform',
        isPlatformBound: approverOutcome.isPlatformBound,
        via: 'passkey_dual_enroll',
      },
    });
  }
```

And extend the final response:

```ts
  return c.json({
    success: true,
    passkey: toPublicPasskey(inserted),
    ...(approverOutcome ? { approver: approverOutcome } : {})
  });
```

- [ ] **Step 4: Run tests — pass**

Run: `cd apps/api && npx vitest run src/routes/auth/passkeys.dualEnroll.test.ts src/routes/auth/helpers.registerStepUp.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/api && npx tsc --noEmit` — expected: 0 errors.

```bash
git add apps/api/src/routes/auth/passkeys.ts apps/api/src/routes/auth/passkeys.dualEnroll.test.ts
git commit -m "feat(auth): dual-enroll approver device at passkey register verify (unified-security-devices P1)"
```

### Task 3: Expose `credentialId` in both list DTOs

Phase 2's merge joins the two lists on `credentialId`; neither DTO exposes it today.

**Files:**
- Modify: `apps/api/src/routes/auth/passkeys.ts` (`toPublicPasskey`) — add `credentialId: row.credentialId`
- Modify: `apps/api/src/routes/authenticator.ts` (`toPublicDevice`) — add `credentialId: row.credentialId` (null for `mobile_hw_key`)
- Test: extend `apps/api/src/routes/auth/passkeys.dualEnroll.test.ts` + the existing `toPublicDevice`/list assertions in `apps/api/src/routes/authenticator.test.ts`

**Interfaces:**
- Produces: `GET /auth/passkeys` items and `GET /me/approver-devices` items both carry `credentialId: string | null`. Phase 2's `mergeSecurityDevices` keys on it. (Credential ids are not secrets — they are sent to any RP interaction.)

- [ ] **Step 1: Write failing assertions** — in each named test file, extend an existing list/DTO test to `expect(item.credentialId).toBe('<the row fixture value>')`.
- [ ] **Step 2: Run both files** — expected FAIL (`credentialId` undefined).
- [ ] **Step 3: Add the field to both `toPublic*` mappers.** One line each; do not add any other row fields.
- [ ] **Step 4: Run both files** — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/passkeys.ts apps/api/src/routes/authenticator.ts apps/api/src/routes/auth/passkeys.dualEnroll.test.ts apps/api/src/routes/authenticator.test.ts
git commit -m "feat(auth): expose credentialId in passkey and approver-device DTOs"
```

**Phase 1 gate:** `cd apps/api && npx vitest run src/routes/auth src/routes/authenticator.test.ts && npx tsc --noEmit` all green → open PR A.

---

## Phase 2 — Web: unified Security devices card (PR B)

### Task 4: Multi-operation mint in the web auth store

**Files:**
- Modify: `apps/web/src/stores/auth.ts` (below `mintAddFactorStepUpGrant`)
- Test: `apps/web/src/stores/auth.passkeys.test.ts` (extend the existing `mintAddFactorStepUpGrant` describe)

**Interfaces:**
- Consumes: Task 1's `{ grants: [{ operation, stepUpGrantId }] }` response; existing `AddFactorStepUp`, `StepUpError`, `fetchWithAuth`.
- Produces: `export type StepUpOperation = 'add_factor' | 'register_approver_device'` and `export async function mintStepUpGrants(stepUp: AddFactorStepUp, operations: StepUpOperation[]): Promise<Partial<Record<StepUpOperation, string>>>`. `mintAddFactorStepUpGrant` becomes a thin wrapper (existing callers untouched). Tasks 5/6/8 call `mintStepUpGrants`.

- [ ] **Step 1: Write failing tests** (same harness as the existing mint describe — authenticated store state, stubbed global fetch):

```ts
it('mints grants for multiple operations from one proof', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse({
    grants: [
      { operation: 'add_factor', stepUpGrantId: 'g-add' },
      { operation: 'register_approver_device', stepUpGrantId: 'g-reg' },
    ],
  }));
  vi.stubGlobal('fetch', fetchMock);
  const grants = await mintStepUpGrants({ method: 'totp', code: '123456' }, ['add_factor', 'register_approver_device']);
  expect(grants).toEqual({ add_factor: 'g-add', register_approver_device: 'g-reg' });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
    method: 'totp', code: '123456',
    operations: ['add_factor', 'register_approver_device'],
  });
});

it('throws StepUpError when a requested grant is missing from the response', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeResponse({ grants: [] })));
  await expect(mintStepUpGrants({ method: 'totp', code: '123456' }, ['add_factor'])).rejects.toMatchObject({ name: 'StepUpError' });
});
```

- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/stores/auth.passkeys.test.ts` — expected FAIL (no export).
- [ ] **Step 3: Implement** — generalize the existing body-building (passkey branch runs the assertion ceremony exactly as today, then sends `operations` instead of `operation`):

```ts
export type StepUpOperation = 'add_factor' | 'register_approver_device';

/** Multi-operation variant of the step-up mint (unified-security-devices
 * §4.1): one factor proof, one grant per requested operation. */
export async function mintStepUpGrants(
  stepUp: AddFactorStepUp,
  operations: StepUpOperation[]
): Promise<Partial<Record<StepUpOperation, string>>> {
  let stepUpBody: Record<string, unknown>;
  if (stepUp.method === 'totp') {
    stepUpBody = { method: 'totp', code: stepUp.code, operations };
  } else {
    const challengeResponse = await fetchWithAuth('/auth/mfa/step-up/options', { method: 'POST' });
    const challengeData = await challengeResponse.json().catch(() => null);
    if (!challengeResponse.ok) {
      throw new StepUpError(challengeData?.error ?? 'Could not start passkey verification.', challengeResponse.status);
    }
    const optionsJSON: PasskeyAuthenticationOptions =
      challengeData?.options ?? challengeData?.optionsJSON ?? challengeData;
    const credential = await startAuthentication({ optionsJSON });
    stepUpBody = { method: 'passkey', credential, operations };
  }

  const response = await fetchWithAuth('/auth/mfa/step-up', {
    method: 'POST',
    body: JSON.stringify(stepUpBody),
    skipUnauthorizedRetry: true,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new StepUpError(data?.error ?? 'Verification failed.', response.status);
  }
  const out: Partial<Record<StepUpOperation, string>> = {};
  for (const g of data?.grants ?? []) {
    if (g?.operation && g?.stepUpGrantId) out[g.operation as StepUpOperation] = g.stepUpGrantId;
  }
  for (const op of operations) {
    if (!out[op]) throw new StepUpError('Verification failed.');
  }
  return out;
}
```

Then rewrite `mintAddFactorStepUpGrant` as:

```ts
export async function mintAddFactorStepUpGrant(stepUp: AddFactorStepUp): Promise<string> {
  const grants = await mintStepUpGrants(stepUp, ['add_factor']);
  return grants.add_factor!;
}
```

- [ ] **Step 4: Run the store suites** — `npx vitest run src/stores` — expected PASS (wrapper keeps all existing tests green; the wrapper now sends `operations: ['add_factor']`, and the server treats that identically).
- [ ] **Step 5: Commit** — `git add apps/web/src/stores/auth.ts apps/web/src/stores/auth.passkeys.test.ts && git commit -m "feat(web): multi-operation step-up grant mint"`

### Task 5: `SecurityDevicesCard` — merged list, badges, per-capability actions

**Files:**
- Create: `apps/web/src/components/settings/SecurityDevicesCard.tsx`
- Create: `apps/web/src/components/settings/securityDevices.ts` (pure merge logic — testable without jsdom ceremony)
- Test: Create `apps/web/src/components/settings/securityDevices.test.ts`
- Test: Create `apps/web/src/components/settings/SecurityDevicesCard.test.tsx`

**Interfaces:**
- Consumes: `PasskeySummary` (now with `credentialId?: string | null`), `ApproverDevice` (likewise) from Task 3; existing `listApproverDevices/revokeApproverDevice/renameApproverDevice` (`stores/authenticator.ts`); existing passkey routes (`GET /auth/passkeys`, `PATCH|DELETE /auth/passkeys/:id`).
- Produces: `export function mergeSecurityDevices(passkeys: PasskeySummary[], approvers: ApproverDevice[]): SecurityDeviceRow[]` with `type SecurityDeviceRow = { key: string; name: string; createdAt?: string; lastUsedAt?: string | null; passkey?: PasskeySummary; approver?: ApproverDevice }`; component `<SecurityDevicesCard mfaEnabled={boolean} mfaMethod={string|null} onFactorAdded={(p: { recoveryCodes?: string[] }) => void} />`. Task 6 mounts it; Task 8 adds a row action to it.

- [ ] **Step 1: Write failing merge tests** (`securityDevices.test.ts`):

```ts
it('joins a passkey and approver device sharing a credentialId into one row', () => {
  const rows = mergeSecurityDevices(
    [{ id: 'pk1', name: 'Laptop', credentialId: 'cred-1', lastUsedAt: null }],
    [{ id: 'ad1', label: 'Laptop', kind: 'webauthn_platform', credentialId: 'cred-1', isPlatformBound: true, createdAt: 'x', lastUsedAt: null }],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].passkey?.id).toBe('pk1');
  expect(rows[0].approver?.id).toBe('ad1');
});

it('keeps unmatched credentials and mobile keys as their own rows', () => {
  const rows = mergeSecurityDevices(
    [{ id: 'pk1', name: 'Laptop', credentialId: 'cred-1', lastUsedAt: null }],
    [{ id: 'ad2', label: 'Phone', kind: 'mobile_hw_key', credentialId: null, isPlatformBound: true, createdAt: 'x', lastUsedAt: null }],
  );
  expect(rows).toHaveLength(2);
});

it('never merges on a null/absent credentialId', () => {
  const rows = mergeSecurityDevices(
    [{ id: 'pk1', name: 'A', credentialId: null, lastUsedAt: null }],
    [{ id: 'ad1', label: 'B', kind: 'webauthn_platform', credentialId: null, isPlatformBound: false, createdAt: 'x', lastUsedAt: null }],
  );
  expect(rows).toHaveLength(2);
});
```

- [ ] **Step 2: Run — FAIL.** `npx vitest run src/components/settings/securityDevices.test.ts`
- [ ] **Step 3: Implement `securityDevices.ts`:**

```ts
import type { ApproverDevice } from '../../stores/authenticator';

// Moved here from ProfilePage.tsx (which now imports it back), gaining the
// Task 3 field.
export type PasskeySummary = {
  id: string;
  name: string;
  createdAt?: string;
  lastUsedAt?: string | null;
  credentialId?: string | null;
};

export type SecurityDeviceRow = {
  key: string;
  name: string;
  createdAt?: string;
  lastUsedAt?: string | null;
  passkey?: PasskeySummary;
  approver?: ApproverDevice;
};

export function mergeSecurityDevices(
  passkeys: PasskeySummary[],
  approvers: ApproverDevice[]
): SecurityDeviceRow[] {
  const rows: SecurityDeviceRow[] = passkeys.map((p) => ({
    key: `pk-${p.id}`,
    name: p.name || 'Passkey',
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt,
    passkey: p,
  }));
  const byCred = new Map(
    rows.filter((r) => r.passkey?.credentialId).map((r) => [r.passkey!.credentialId as string, r])
  );
  for (const a of approvers) {
    const match = a.credentialId ? byCred.get(a.credentialId) : undefined;
    if (match) {
      match.approver = a;
      // Prefer the more recent activity across both capabilities.
      if (a.lastUsedAt && (!match.lastUsedAt || a.lastUsedAt > match.lastUsedAt)) {
        match.lastUsedAt = a.lastUsedAt;
      }
    } else {
      rows.push({
        key: `ad-${a.id}`,
        name: a.label?.trim() || 'Unnamed device',
        createdAt: a.createdAt,
        lastUsedAt: a.lastUsedAt,
        approver: a,
      });
    }
  }
  return rows;
}
```

(`PasskeySummary` moves out of `ProfilePage.tsx` into this module — export it here and import it back in `ProfilePage.tsx`, adding `credentialId?: string | null`.)

- [ ] **Step 4: Run — PASS**, commit merge logic: `git add ... && git commit -m "feat(web): security-device merge logic"`
- [ ] **Step 5: Write failing component tests** (`SecurityDevicesCard.test.tsx`, harness copied from `ProfilePage.passkeys.test.tsx`: mock `stores/auth` incl. `mintStepUpGrants`, mock `stores/authenticator` list/revoke/rename fns, mock `lib/runAction` passthrough). Cover: (a) merged row renders `Sign-in` + `Approvals` badges + `Platform-bound` when `isPlatformBound`; (b) approver-only pending row shows the pending badge; (c) `Revoke approvals` calls `revokeApproverDevice(id)` and never any `/auth/passkeys` DELETE; (d) passkey delete still requires the password field (mirror the existing `sends currentPassword when deleting a passkey` test); (e) rename on a merged row PATCHes the passkey AND calls `renameApproverDevice` with the same value.
- [ ] **Step 6: Run — FAIL**, then implement the card. Structure: lift the passkey list/add/delete/rename state + handlers out of `ProfilePage.tsx` (lines ~75–100 state, ~486–680 handlers, ~840–990 JSX) and the device list rendering out of `ApproverDevicesSection.tsx` into `SecurityDevicesCard.tsx`, rendering `mergeSecurityDevices(...)` rows with badge spans (`data-testid`: `secdev-badge-signin` when `row.passkey`, `secdev-badge-approvals` when `row.approver`, `secdev-badge-platform` when `row.approver?.isPlatformBound`, `secdev-badge-pending` when `row.approver && row.approver.lastUsedAt === null`, `secdev-badge-synced` on merged rows with `row.approver?.isPlatformBound === false` — the passkey DTO doesn't expose `backedUp`, so synced-ness is only known once the credential is also an approver device). Keep the existing step-up tier logic + `StepUpPrompt` (`idPrefix="passkey-stepup"`) exactly as `ProfilePage` has it today — the card receives `mfaEnabled`/`mfaMethod` props and owns `passkeys` state.
- [ ] **Step 7: Run — PASS.**
- [ ] **Step 8: Commit** — `git commit -m "feat(web): unified SecurityDevicesCard (list + per-capability actions)"`

### Task 6: Dual-enroll checkbox in the add flow

**Files:**
- Modify: `apps/web/src/components/settings/SecurityDevicesCard.tsx` (add form)
- Test: extend `apps/web/src/components/settings/SecurityDevicesCard.test.tsx`

**Interfaces:**
- Consumes: Task 4's `mintStepUpGrants`; Task 2's `approverRegisterGrantId` verify field + `approver` response block; existing `/authenticator/register-grant` password mint (for unprotected accounts — POST `{ currentPassword }`, response `{ registerGrantId }`).
- Produces: checkbox `data-testid="secdev-also-approver"`, default **checked** (spec §7.1).

- [ ] **Step 1: Write failing tests:**

```ts
it('mints both grants in one step-up and sends approverRegisterGrantId to verify (protected account)', async () => {
  mintStepUpGrantsMock.mockResolvedValueOnce({ add_factor: 'g-add', register_approver_device: 'g-reg' });
  // render with mfaEnabled + mfaMethod 'totp'; fill name/password/code; leave checkbox checked; submit
  // fetch order: passkeys list → register/options → register/verify → passkeys reload → approver-devices reload
  expect(mintStepUpGrantsMock).toHaveBeenCalledWith(
    { method: 'totp', code: '123456' },
    ['add_factor', 'register_approver_device'],
  );
  expect(JSON.parse(optionsCall.body).stepUpGrantId).toBe('g-add');
  const verifyBody = JSON.parse(verifyCall.body);
  expect(verifyBody.stepUpGrantId).toBe('g-add');
  expect(verifyBody.approverRegisterGrantId).toBe('g-reg');
});

it('unchecking the box keeps the flow single-purpose', async () => {
  mintStepUpGrantsMock.mockResolvedValueOnce({ add_factor: 'g-add' });
  // uncheck secdev-also-approver, submit
  expect(mintStepUpGrantsMock).toHaveBeenCalledWith({ method: 'totp', code: '123456' }, ['add_factor']);
  expect(JSON.parse(verifyCall.body).approverRegisterGrantId).toBeUndefined();
});

it('uses the password register-grant fallback for unprotected accounts', async () => {
  // mfaEnabled false, no passkeys: no step-up mint; expect POST /authenticator/register-grant
  // with { currentPassword }, then approverRegisterGrantId from its registerGrantId.
});

it('surfaces the degraded outcome', async () => {
  // verify responds { success: true, passkey, approver: { registered: false, reason: 'grant_invalid' } }
  // expect the partial-success message (passkey added, approvals not enabled) rendered.
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** In the add handler: `const ops: StepUpOperation[] = alsoApprover ? ['add_factor', 'register_approver_device'] : ['add_factor'];` for protected tiers → `mintStepUpGrants(proof, ops)`; unprotected + `alsoApprover` → `POST /authenticator/register-grant { currentPassword: passkeyPassword }` (degrade to passkey-only on its 403, matching the server's `stronger_factor_required` contract). Send both grant ids as Task 2 specifies. On response: `approver?.registered === false` → success message uses the partial key; `approver?.isPlatformBound === false` → append the synced note.
- [ ] **Step 4: Run — PASS. Commit** `feat(web): dual-enroll checkbox in add-device flow`.

### Task 7: Mount the card; retire the old sections; i18n

**Files:**
- Modify: `apps/web/src/components/settings/ProfilePage.tsx` (remove passkey card state/handlers/JSX + `ApproverDevicesSection` mount + the two group headers → one "Security devices" group header + `<SecurityDevicesCard .../>`)
- Modify: `apps/web/src/components/settings/ProfilePage.passkeys.test.tsx` (retarget passkey-flow tests at `SecurityDevicesCard.test.tsx`; keep only the ProfilePage-level wiring assertions: card mounted with `mfaEnabled`/`mfaMethod` props; `onFactorAdded` updates recovery codes + `mfaEnabled`)
- Delete usage (file stays for now): `ApproverDevicesSection` import in ProfilePage — the component itself is deleted in this task ONLY if nothing else imports it (`grep -rn "ApproverDevicesSection" apps/web/src` must show only its own files/tests before deleting; otherwise leave and file a follow-up).
- Modify: all five `apps/web/src/locales/*/settings.json`

**New i18n keys** (namespace `settings`, section `securityDevicesCard`) — add ALL of these to ALL five locales, translated: `securityDevices` ("Security devices"), `oneListDescription` ("Every credential on your account — what it can sign you into and what it can approve."), `signInBadge` ("Sign-in"), `approvalsBadge` ("Approvals"), `platformBoundBadge` ("Platform-bound"), `pendingBadge` ("Pending — activates on first approval"), `syncedBadge` ("Synced"), `alsoUseForApprovals` ("Also use this device to approve high-risk actions"), `addedButApprovalsFailed` ("Passkey added. Approvals could not be enabled — verify again to add them."), `addedSyncedNote` ("Registered for approvals. This is a synced credential, so it can't confirm critical-tier approvals."), `removeSignIn` ("Remove sign-in"), `revokeApprovals` ("Revoke approvals").

- [ ] **Step 1:** Update ProfilePage + tests; move keys; run `npx vitest run src/components/settings src/lib/i18n` — PASS (includes locale parity + key-usage gates).
- [ ] **Step 2:** `npx astro check` — 0 errors. `npx vitest run src/lib/__tests__/no-silent-mutations.test.ts` — PASS.
- [ ] **Step 3: Commit** `feat(web): unified Security devices card on profile (replaces Passkeys + Approval security cards)`.

**Phase 2 gate:** full `cd apps/web && npx vitest run` green + `astro check` 0 errors → open PR B.

---

## Phase 3 — Retrofit: adopt an existing passkey as an approver device (PR C)

### Task 8: `POST /authenticator/devices/webauthn/adopt`

**Design note (deviation from spec §4.4, same guarantees):** no new `/adopt/options` challenge infra. The client gets its assertion challenge from the existing authenticated `POST /auth/mfa/step-up/options` (challenge covers all the user's active passkeys), and the server verifies via the existing `verifyStepUpPasskeyAssertion(userId, credential)` (`routes/auth/passkeys.ts:288` — single-use challenge, counter update included). The adopt route then resolves WHICH credential was asserted from `credential.id`, and the grant is consumed at this single terminal write (two-phase validate is unnecessary with no intermediate server step). Possession proof + no-bypass grant are both still required at the write.

**Files:**
- Modify: `apps/api/src/routes/authenticator.ts` (new route + schema)
- Test: Create `apps/api/src/routes/authenticator.adopt.test.ts`

**Interfaces:**
- Consumes: `verifyStepUpPasskeyAssertion` (import from `./auth/passkeys`), `enforceApproverRegisterStepUp` (already imported), `userPasskeys` schema, `authenticatorDevices` schema.
- Produces: `POST /authenticator/devices/webauthn/adopt` body `{ registerGrantId: string, credential: <webauthn assertion json>, label?: string }` → `200 { success: true, device: <toPublicDevice> }` | `403 register_step_up_required` | `401 { error: 'Invalid credentials' }` | `409 { error: 'already_registered' }` | `404 { error: 'Passkey not found' }`. Task 9's UI consumes exactly these.

- [ ] **Step 1: Write failing tests** (`authenticator.adopt.test.ts`, harness copied from `authenticator.test.ts`):

```ts
it('fails closed with no grant (stolen bearer token)', async () => {
  // enforceApproverRegisterStepUp real logic + getRedis mocked to null → gate 403s
  const res = await postAdopt({ registerGrantId: 'g-x', credential: { id: 'cred-1' } });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toBe('register_step_up_required');
  expect(dbInsert).not.toHaveBeenCalled();
});

it('401s when the assertion does not verify, without burning an insert', async () => {
  enforceApproverRegisterStepUp.mockResolvedValueOnce(null);
  verifyStepUpPasskeyAssertion.mockResolvedValueOnce(false);
  const res = await postAdopt({ registerGrantId: 'g-ok', credential: { id: 'cred-1' } });
  expect(res.status).toBe(401);
  expect(dbInsert).not.toHaveBeenCalled();
});

it('adopts: copies the passkey record, isPlatformBound derived, lastUsedAt set (assertion WAS the PoP)', async () => {
  enforceApproverRegisterStepUp.mockResolvedValueOnce(null);
  verifyStepUpPasskeyAssertion.mockResolvedValueOnce(true);
  passkeyRowFixture({ credentialId: 'cred-1', deviceType: 'singleDevice', backedUp: false, publicKey: 'pk', counter: 7 });
  const res = await postAdopt({ registerGrantId: 'g-ok', credential: { id: 'cred-1' }, label: 'Laptop' });
  expect(res.status).toBe(200);
  expect(dbInsert.mock.calls[0][0]).toMatchObject({
    kind: 'webauthn_platform', credentialId: 'cred-1', isPlatformBound: true, signCount: 7,
  });
  expect(dbInsert.mock.calls[0][0].lastUsedAt).toBeInstanceOf(Date);
});

it('409s when the credential is already an approver device', async () => {
  // unique-violation from the insert (code 23505) → 409 already_registered
});

it('404s when the asserted credential does not belong to the caller / is disabled', async () => {
  enforceApproverRegisterStepUp.mockResolvedValueOnce(null);
  verifyStepUpPasskeyAssertion.mockResolvedValueOnce(true);
  passkeyRowFixture(null);
  expect((await postAdopt({ registerGrantId: 'g-ok', credential: { id: 'cred-other' } })).status).toBe(404);
});
```

- [ ] **Step 2: Run — FAIL** (route 404).
- [ ] **Step 3: Implement.** Schema next to the existing register schemas in `authenticator.ts`:

```ts
const adoptSchema = z.object({
  registerGrantId: z.string().min(1),
  credential: z.any().refine(
    (v): boolean => typeof v?.id === 'string' && v.id.length > 0,
    { message: 'credential.id is required' }
  ),
  label: z.string().trim().min(1).max(255).optional(),
});
```

Route (after the webauthn/verify route):

```ts
// Retrofit (unified-security-devices §4.4): promote an EXISTING login passkey
// to an approver device. Requires BOTH proofs at this single terminal write:
// the no-bypass register grant (step-up) AND a live assertion from the passkey
// itself (proof the key is present on THIS device NOW — a bearer token alone
// must never copy a credential into the approver store). Because possession
// was just proven live, the row is inserted ACTIVE (last_used_at set), not
// pending: the assertion IS the possession proof deferred-PoP normally waits for.
authenticatorRoutes.post(
  '/devices/webauthn/adopt',
  authMiddleware,
  zValidator('json', adoptSchema),
  async (c) => {
    const auth = c.get('auth');
    const { registerGrantId, credential, label } = c.req.valid('json');

    const grantError = await enforceApproverRegisterStepUp(c, auth, registerGrantId, { consume: true });
    if (grantError) return grantError;

    const ok = await verifyStepUpPasskeyAssertion(auth.user.id, credential);
    if (!ok) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const [pk] = await db
      .select()
      .from(userPasskeys)
      .where(and(
        eq(userPasskeys.userId, auth.user.id),
        eq(userPasskeys.credentialId, credential.id as string),
        isNull(userPasskeys.disabledAt)
      ))
      .limit(1);
    if (!pk) {
      return c.json({ error: 'Passkey not found' }, 404);
    }

    let inserted;
    try {
      [inserted] = await db
        .insert(authenticatorDevices)
        .values({
          userId: auth.user.id,
          kind: 'webauthn_platform',
          label: label ?? pk.name ?? 'This device',
          publicKey: pk.publicKey,
          credentialId: pk.credentialId,
          signCount: pk.counter,
          aaguid: pk.aaguid,
          transports: (pk.transports ?? undefined) as ApproverDeviceRow['transports'],
          isPlatformBound: pk.deviceType === 'singleDevice' && !pk.backedUp,
          lastUsedAt: new Date(),
        })
        .returning();
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        return c.json({ error: 'already_registered' }, 409);
      }
      throw err;
    }
    if (!inserted) throw new Error('Approver device insert returned no row');

    writeAuthAudit(c, {
      orgId: auth.orgId ?? undefined,
      action: 'auth.authenticator.device.register',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: {
        deviceId: inserted.id,
        kind: 'webauthn_platform',
        isPlatformBound: inserted.isPlatformBound,
        via: 'passkey_adopt',
      },
    });

    return c.json({ success: true, device: toPublicDevice(inserted) });
  }
);
```

Imports to add in `authenticator.ts`: `verifyStepUpPasskeyAssertion` from `./auth/passkeys`; `userPasskeys` from the schema barrel; `and`, `isNull` from `drizzle-orm` if not present.

- [ ] **Step 4: Run — PASS**, plus `npx vitest run src/routes/authenticator.test.ts` (no regressions), `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(auth): adopt an existing passkey as an approver device (assertion-as-PoP)`.

### Task 9: "Enable approvals" row action

**Files:**
- Modify: `apps/web/src/components/settings/SecurityDevicesCard.tsx`
- Modify: `apps/web/src/stores/authenticator.ts` (add `adoptPasskeyAsApprover`)
- Test: extend `SecurityDevicesCard.test.tsx` + `apps/web/src/stores/authenticator.test.ts`
- Modify: all five locale `settings.json` (`securityDevicesCard.enableApprovals` "Enable approvals", `securityDevicesCard.approvalsEnabled` "This device can now approve requests.", `securityDevicesCard.alreadyRegistered` "This device is already registered for approvals.")

**Interfaces:**
- Consumes: Task 8's route contract; Task 4's `mintStepUpGrants(proof, ['register_approver_device'])`; existing `getPasskeyCredential` + `POST /auth/mfa/step-up/options` (challenge), `StepUpPrompt` + `pickReauthTier` for the proof input.
- Produces: `export async function adoptPasskeyAsApprover(registerGrantId: string, label?: string): Promise<void>` in `stores/authenticator.ts` — fetches `/auth/mfa/step-up/options`, runs `startAuthentication`, POSTs `/authenticator/devices/webauthn/adopt` (with `skipUnauthorizedRetry: true` — the assertion is single-use), throws `RegisterStepError` with `status` on failure (same class/pattern as `mintRegisterGrant` in the same file).

- [ ] **Step 1: Failing store test:** assert `adoptPasskeyAsApprover('g-1', 'Laptop')` calls options → `startAuthentication` → POST adopt with `{ registerGrantId: 'g-1', credential, label: 'Laptop' }`; a 409 rejects with `status: 409`.
- [ ] **Step 2: Failing component test:** a sign-in-only row shows the `Enable approvals` action; clicking it with tier `totp` renders `StepUpPrompt` (`idPrefix="secdev-adopt"`), and confirming calls `mintStepUpGrantsMock` with `['register_approver_device']` then `adoptPasskeyAsApproverMock` with the minted grant; on success the row gains the Approvals badge (list refetched). A 409 maps to the `alreadyRegistered` toast.
- [ ] **Step 3: Implement both; run `npx vitest run src/components/settings/SecurityDevicesCard.test.tsx src/stores/authenticator.test.ts` — PASS.** UX note (spec-accepted): passkey-tier users see two biometric prompts (mint assertion + adopt assertion); TOTP users see one.
- [ ] **Step 4: i18n keys in all five locales; run `npx vitest run src/lib/i18n` — PASS.**
- [ ] **Step 5: Commit** `feat(web): enable approvals on an existing passkey (adopt flow)`.

**Phase 3 gate:** `cd apps/api && npx vitest run src/routes/authenticator* && npx tsc --noEmit`; `cd apps/web && npx vitest run && npx astro check` → open PR C.

---

## Post-plan follow-ups (explicitly NOT in this plan)

- Cross-store sign-count regression test against a REAL verifier pair (spec §4.2 note) — belongs with the first live-DB integration pass; the unit suites above pin the insert values only.
- SMS authenticated step-up sender (spec §8) — separate issue, unblocks the `sms` tier everywhere at once.
- Deleting `ApproverDevicesSection.tsx` + its test file once nothing imports it (checked in Task 7).
- Docs sweep (`apps/docs/`) after PR B ships the visible UI change — use `update-breeze-docs`.
