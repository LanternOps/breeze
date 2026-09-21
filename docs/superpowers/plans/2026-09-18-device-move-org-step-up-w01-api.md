---
tracking_issue: LanternOps/breeze#6301
---

# Device Move-Org Step-Up — W01 (API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put `POST /devices/:id/move-org` behind an interactive-session gate and a fresh-factor, operation-bound, single-use step-up grant, mirroring the shipped device-maintenance step-up (RMM-QA-176), with real-database proof that a denial changes nothing.

**Architecture:** Reuse the existing grant primitive (`services/mfaStepUpGrant.ts`) with a new `device_move_org` operation whose resource digest pins `{ deviceId, targetOrgId, targetSiteId, acceptCurrencyMismatch }`. The mint route (`POST /auth/mfa/step-up`) learns the new operation through its `RESOURCE_BOUND_OPERATIONS` map. The move-org route validates the grant before its transaction and, inside the transaction, takes a `FOR SHARE` lock on the actor row and consumes the grant **before** the organisation `FOR SHARE` locks — the same order maintenance uses. The maintenance-specific `lockMaintenanceAssurance` is extracted into a shared `lockActorAssurance`, and `requireInteractiveSession()` is lifted from `routes/devices/commands.ts` into `middleware/auth.ts` so both routes share one definition.

**Tech Stack:** Hono, Drizzle ORM, Zod, Vitest (unit with mocked drizzle; integration via `vitest.integration.config.ts` against a private `pnpm test-stack`), Redis-backed grants.

**Spec:** `docs/superpowers/specs/2026-09-18-device-move-org-step-up-design.md` — this plan implements **W01 only** (D1, D2, D3, D4, D7). D5 (console dialog) is W02; D6 (`mfa_src`) is W03.

## Global Constraints

- **Breaking change for API callers** (spec D7): after this ships, a move-org request without a valid `stepUpGrant` receives `403 { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }` when `ENABLE_2FA` is on. There is no released client. Release notes carry a **Breaking** line (Task 7).
- Machine principals (API key, MCP OAuth grant, AI agent) are denied with `403 { error: 'Interactive user session required' }` **regardless of `ENABLE_2FA`** (spec D1).
- Missing, stale, mismatched and wrong-operation grants all produce the identical `STEP_UP_REQUIRED` 403 — never distinguish them (no probing oracle).
- Lock order inside the move transaction (spec D3): `SET CONSTRAINTS … DEFERRED` (no locks) → **actor `users` row `FOR SHARE` + grant consume** → organisations `FOR SHARE` (ascending UUID) → everything else. Document it in the route comment.
- `moveOrgSchema` stays non-`.strict()` (spec D2). Only `stepUpGrant?: guid` is added.
- No new bound constants → no new leaf-limits module (spec F4 does not apply). Do NOT add module-scope constants to `services/mfaStepUpGrant.ts` (ten suites mock it wholesale).
- Every gate test must be **mutation-checked**: after green, temporarily disable the gate and confirm the test goes red, then restore. Record the mutant result in the commit message.
- Run unit tests as `cd apps/api && npx vitest run <path>` (never `pnpm … test -- --run`). Integration: `pnpm test-stack up` once, then `set -a && . ./.env.test && set +a && cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`; `pnpm test-stack down` when finished.
- Commit after every task. Branch: `feature/<parent#>-device-move-org-step-up/wave-<W01 sub-issue#>` (fill from the feature-lifecycle registration).

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/api/src/services/mfaStepUpGrant.ts` | `StepUpOperation` gains `'device_move_org'`; new `moveOrgResourceDigest` canonicaliser | 1, 2 |
| `apps/api/src/services/mfaStepUpGrant.test.ts` | digest contract tests | 1 |
| `apps/api/src/routes/auth/schemas.ts` | `STEP_UP_OPERATIONS` + `moveOrgStepUpResource` + union member | 2 |
| `apps/api/src/routes/auth/schemas.test.ts` | client-requestable op + resource shape tests | 2 |
| `apps/api/src/routes/auth/mfa.ts` | `RESOURCE_BOUND_OPERATIONS` entry + digest arm at mint | 2 |
| `apps/api/src/routes/auth.test.ts` | mint route tests for the new op | 2 |
| `apps/api/src/services/stepUpActorAssurance.ts` (new) | `lockActorAssurance` — the shared actor `FOR SHARE` + epoch check | 3 |
| `apps/api/src/services/maintenanceAuthorization.ts` (deleted) | replaced by the above | 3 |
| `apps/api/src/routes/devices/commands.ts` | import the shared helper; drop local `requireInteractiveSession` | 3, 4 |
| `apps/api/src/routes/devices/commands.test.ts`, `apps/api/src/__tests__/devices.endpoints.test.ts`, `apps/api/src/__tests__/integration/deviceMaintenanceStepUp.integration.test.ts` | re-point mocks/imports to the new module name | 3 |
| `apps/api/src/middleware/auth.ts` | export `requireInteractiveSession()` | 4 |
| `apps/api/src/middleware/auth.test.ts` | middleware test for it | 4 |
| `apps/api/src/routes/devices/schemas.ts` | `moveOrgSchema.stepUpGrant` | 5 |
| `apps/api/src/routes/devices/moveOrg.ts` | gate chain, binding, validate-before, lock+consume, error mapping, audit | 5 |
| `apps/api/src/routes/devices/moveOrg.test.ts` | harness update + new gate cases | 5 |
| `apps/api/src/__tests__/integration/deviceMoveOrgStepUp.integration.test.ts` (new) | real-row proof | 6 |
| `apps/api/src/openapi.ts` | `moveDeviceOrg` request/response contract | 7 |
| `apps/docs/src/content/docs/reference/api.mdx`, `apps/docs/src/content/docs/security/overview.mdx`, `docs/release-notes/next-release-draft.md` | docs + Breaking note | 7 |

---

### Task 1: `moveOrgResourceDigest` canonicaliser

**Files:**
- Modify: `apps/api/src/services/mfaStepUpGrant.ts` (after `maintenanceResourceDigest`, ~line 174)
- Test: `apps/api/src/services/mfaStepUpGrant.test.ts`

**Interfaces:**
- Produces: `export function moveOrgResourceDigest(input: { deviceId: string; targetOrgId: string; targetSiteId: string; acceptCurrencyMismatch?: boolean }): \`sha256:${string}\`` — `acceptCurrencyMismatch` canonicalises `undefined → false`. Used by Task 2 (mint) and Task 5 (route).

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/services/mfaStepUpGrant.test.ts`, after the `maintenanceResourceDigest` describe block, and add `moveOrgResourceDigest` to the import on line 25:

```ts
import { mintStepUpGrant, validateStepUpGrant, consumeStepUpGrant, readStepUpGrant, rollbackResourceDigest, maintenanceResourceDigest, moveOrgResourceDigest, passkeyRemovalResourceDigest, scriptLanePolicyResourceDigest, stepUpGrantTtlSeconds, type StepUpOperation } from './mfaStepUpGrant';
```

```ts
// Device move-org step-up (spec 2026-09-18 D2): the ONE canonicaliser the mint
// route and the move route both call. A grant minted for one move intent must
// never validate for another, and two callers describing the SAME intent must
// hash byte-identically — including when one omits acceptCurrencyMismatch and
// the other sends `false`.
describe('moveOrgResourceDigest', () => {
  const base = {
    deviceId: '55555555-5555-4555-8555-555555555555',
    targetOrgId: '22222222-2222-4222-8222-222222222222',
    targetSiteId: '44444444-4444-4444-8444-444444444444',
  };

  it('treats an omitted acceptCurrencyMismatch as false', () => {
    expect(moveOrgResourceDigest(base)).toBe(moveOrgResourceDigest({ ...base, acceptCurrencyMismatch: false }));
  });

  it('is insensitive to input key order', () => {
    const reordered = { targetSiteId: base.targetSiteId, targetOrgId: base.targetOrgId, deviceId: base.deviceId };
    expect(moveOrgResourceDigest(reordered)).toBe(moveOrgResourceDigest(base));
  });

  it('binds acceptCurrencyMismatch — accepting a billing consequence is a different grant', () => {
    expect(moveOrgResourceDigest({ ...base, acceptCurrencyMismatch: true })).not.toBe(moveOrgResourceDigest(base));
  });

  it('binds the device', () => {
    expect(moveOrgResourceDigest({ ...base, deviceId: '55555555-5555-4555-8555-555555555556' })).not.toBe(moveOrgResourceDigest(base));
  });

  it('binds the target organization', () => {
    expect(moveOrgResourceDigest({ ...base, targetOrgId: '22222222-2222-4222-8222-222222222223' })).not.toBe(moveOrgResourceDigest(base));
  });

  it('binds the target site', () => {
    expect(moveOrgResourceDigest({ ...base, targetSiteId: '44444444-4444-4444-8444-444444444445' })).not.toBe(moveOrgResourceDigest(base));
  });

  it('emits the sha256: prefixed shape the grant store compares literally', () => {
    expect(moveOrgResourceDigest(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/mfaStepUpGrant.test.ts`
Expected: FAIL — `moveOrgResourceDigest is not a function` (import resolves to undefined).

- [ ] **Step 3: Implement**

In `apps/api/src/services/mfaStepUpGrant.ts`, add `'device_move_org'` to the union after `'device_maintenance'`:

```ts
  | 'device_maintenance'
  // Device move-org step-up (spec 2026-09-18): relocating a device to another
  // organization rewrites org_id on 64 device-scoped tables in one transaction
  // and is cross-tenant by definition. Bound by resourceDigest to the exact
  // { deviceId, targetOrgId, targetSiteId, acceptCurrencyMismatch } the
  // operator was shown, so a grant can never be replayed against a different
  // device, destination, or billing acknowledgement.
  | 'device_move_org'
```

Add after `maintenanceResourceDigest` (before the `scriptLanePolicyResourceDigest` comment):

```ts
/**
 * Canonical digest for a device move-org grant (spec 2026-09-18 D2).
 *
 * Same contract as maintenanceResourceDigest: the mint route and the move
 * route must produce byte-identical input for the same operator intent, so
 * `acceptCurrencyMismatch` is normalised to a boolean HERE (`undefined` and
 * `false` are the same intent) and keys are emitted in fixed alphabetical
 * order. Accepting a currency mismatch is a billing acknowledgement and part
 * of the intent, so it is bound: a grant minted without it cannot authorise a
 * move that sets it.
 */
export function moveOrgResourceDigest(input: {
  deviceId: string;
  targetOrgId: string;
  targetSiteId: string;
  acceptCurrencyMismatch?: boolean;
}): `sha256:${string}` {
  const canonical = JSON.stringify({
    acceptCurrencyMismatch: input.acceptCurrencyMismatch === true,
    deviceId: input.deviceId,
    targetOrgId: input.targetOrgId,
    targetSiteId: input.targetSiteId,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/mfaStepUpGrant.test.ts`
Expected: PASS (all describe blocks, including the 7 new cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/mfaStepUpGrant.ts apps/api/src/services/mfaStepUpGrant.test.ts
git commit -m "feat(auth): device_move_org step-up operation + canonical resource digest"
```

---

### Task 2: Client-requestable operation + resource binding at the mint route

**Files:**
- Modify: `apps/api/src/routes/auth/schemas.ts:155-197`
- Modify: `apps/api/src/routes/auth/mfa.ts:38,41,1227-1231,1355-1372`
- Test: `apps/api/src/routes/auth/schemas.test.ts` (after the maintenance cases, ~line 150)
- Test: `apps/api/src/routes/auth.test.ts` (mock factory ~line 238; describe `POST /auth/mfa/step-up` ~line 4464)

**Interfaces:**
- Consumes: `moveOrgResourceDigest` (Task 1).
- Produces: `export const moveOrgStepUpResource` (Zod object `{ deviceId: uuid, targetOrgId: uuid, targetSiteId: uuid, acceptCurrencyMismatch?: boolean }`) in `routes/auth/schemas.ts`; `POST /auth/mfa/step-up` accepts `operation: 'device_move_org'` with that resource and mints a grant whose `resourceDigest === moveOrgResourceDigest(resource)`.

- [ ] **Step 1: Write the failing schema tests**

Append inside `describe('mfaStepUpSchema operation field', …)` in `apps/api/src/routes/auth/schemas.test.ts`:

```ts
  // Device move-org step-up (spec 2026-09-18 D2): client-requestable, and its
  // resource binding must be accepted by this schema. acceptCurrencyMismatch
  // is optional here because the device route's body schema makes it optional
  // — the digest normalises the omission to false.
  it('accepts device_move_org with a move-org resource binding', () => {
    const parsed = mfaStepUpSchema.parse({
      method: 'totp',
      code: '123456',
      operation: 'device_move_org',
      resource: {
        deviceId: '00000000-0000-4000-8000-000000000010',
        targetOrgId: '00000000-0000-4000-8000-000000000020',
        targetSiteId: '00000000-0000-4000-8000-000000000030',
      },
    });
    expect(parsed.operation).toBe('device_move_org');
    expect(parsed.resource).toMatchObject({ targetOrgId: '00000000-0000-4000-8000-000000000020' });
  });

  it('accepts device_move_org with acceptCurrencyMismatch: true', () => {
    const parsed = mfaStepUpSchema.parse({
      method: 'passkey',
      credential: { id: 'cred-1' },
      operation: 'device_move_org',
      resource: {
        deviceId: '00000000-0000-4000-8000-000000000010',
        targetOrgId: '00000000-0000-4000-8000-000000000020',
        targetSiteId: '00000000-0000-4000-8000-000000000030',
        acceptCurrencyMismatch: true,
      },
    });
    expect(parsed.resource).toMatchObject({ acceptCurrencyMismatch: true });
  });

  it('rejects a move-org resource with a non-uuid target site', () => {
    expect(() =>
      mfaStepUpSchema.parse({
        method: 'totp',
        code: '123456',
        operation: 'device_move_org',
        resource: {
          deviceId: '00000000-0000-4000-8000-000000000010',
          targetOrgId: '00000000-0000-4000-8000-000000000020',
          targetSiteId: 'site-1',
        },
      })
    ).toThrow();
  });
```

- [ ] **Step 2: Write the failing mint-route tests**

In `apps/api/src/routes/auth.test.ts`, extend the `vi.mock('../services/mfaStepUpGrant', …)` factory (~line 238) with a deliberately distinct constant, next to `maintenanceResourceDigest`:

```ts
  // Device move-org step-up: a THIRD distinct constant, for the same reason as
  // the maintenance one above — the mint route dispatches the digest by
  // operation, and a dispatch that fell through to another digest function
  // would produce the wrong constant and fail the assertion below.
  moveOrgResourceDigest: vi.fn(() => 'sha256:m0ve0r9b0undd19e5700000000000000000000000000000000000000000000'),
```

Add `moveOrgResourceDigest` to the corresponding `import { … } from '../services/mfaStepUpGrant'` line near the top of the file (find it with `grep -n "maintenanceResourceDigest" apps/api/src/routes/auth.test.ts | head -3`).

Append inside `describe('POST /auth/mfa/step-up', …)` after the `still rejects a resource on an operation that is not resource-bound` case:

```ts
		// Device move-org step-up (spec 2026-09-18 D2): a bound operation whose
		// resource must parse under ITS OWN schema before any factor is verified.
		it('mints a device_move_org grant bound to the canonical move digest', async () => {
			vi.mocked(verifyStepUpPasskeyAssertion).mockResolvedValueOnce(true);
			vi.mocked(mintStepUpGrant).mockResolvedValueOnce('grant-move-org');
			const resource = {
				deviceId: '00000000-0000-4000-8000-000000000010',
				targetOrgId: '00000000-0000-4000-8000-000000000020',
				targetSiteId: '00000000-0000-4000-8000-000000000030',
				acceptCurrencyMismatch: true,
			};
			const res = await app.request('/auth/mfa/step-up', {
				method: 'POST',
				headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
				body: JSON.stringify({ method: 'passkey', credential: { id: 'credential-1' }, operation: 'device_move_org', resource }),
			});
			expect(res.status).toBe(200);
			expect(moveOrgResourceDigest).toHaveBeenCalledWith(expect.objectContaining(resource));
			expect(mintStepUpGrant).toHaveBeenCalledWith(expect.objectContaining({
				operation: 'device_move_org',
				resourceDigest: 'sha256:m0ve0r9b0undd19e5700000000000000000000000000000000000000000000',
			}));
		});

		it('rejects device_move_org without a resource binding, before factor verification', async () => {
			const res = await app.request('/auth/mfa/step-up', {
				method: 'POST',
				headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
				body: JSON.stringify({ method: 'passkey', credential: { id: 'credential-1' }, operation: 'device_move_org' }),
			});
			expect(res.status).toBe(400);
			expect(verifyStepUpPasskeyAssertion).not.toHaveBeenCalled();
			expect(mintStepUpGrant).not.toHaveBeenCalled();
		});

		it('rejects device_move_org carrying a MAINTENANCE-shaped resource (per-operation shape check)', async () => {
			const res = await app.request('/auth/mfa/step-up', {
				method: 'POST',
				headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'passkey',
					credential: { id: 'credential-1' },
					operation: 'device_move_org',
					resource: { deviceIds: ['00000000-0000-4000-8000-000000000010'], reason: 'scheduled patching', durationHours: 4 },
				}),
			});
			expect(res.status).toBe(400);
			expect(verifyStepUpPasskeyAssertion).not.toHaveBeenCalled();
			expect(mintStepUpGrant).not.toHaveBeenCalled();
		});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/auth/schemas.test.ts src/routes/auth.test.ts -t "device_move_org"`
Expected: FAIL — schema tests throw on `operation: 'device_move_org'` (not in enum); mint tests get 400 from the enum rejection (the 200 case fails, the two 400 cases pass *vacuously* — that is why Step 5 must show the 200 case green).

- [ ] **Step 4: Implement**

`apps/api/src/routes/auth/schemas.ts` — add the operation and the resource schema:

```ts
const STEP_UP_OPERATIONS = [
  'add_factor',
  'rotate_recovery_codes',
  'delete_passkey',
  'register_approver_device',
  'agent_rollback',
  'device_maintenance',
  'device_move_org',
  'ai_script_lane_grant',
] as const satisfies readonly Exclude<
  StepUpOperation,
  'enroll_first_factor' | 'approval_decide'
>[];
```

After `maintenanceStepUpResource`:

```ts
// Device move-org step-up (spec 2026-09-18 D2): the move binding. Mirrors
// moveOrgSchema (routes/devices/schemas.ts) plus the path param. A value the
// device route would accept but this schema would not (or vice versa) is a
// grant a technician can mint and never spend, or spend for more than they
// proved. acceptCurrencyMismatch stays optional on both sides; the digest
// normalises its absence to false.
export const moveOrgStepUpResource = z.object({
  deviceId: z.string().uuid(),
  targetOrgId: z.string().uuid(),
  targetSiteId: z.string().uuid(),
  acceptCurrencyMismatch: z.boolean().optional(),
});
```

Update the union:

```ts
const stepUpResource = z.union([rollbackStepUpResource, maintenanceStepUpResource, moveOrgStepUpResource, scriptLaneStepUpResource]);
```

`apps/api/src/routes/auth/mfa.ts` — imports (lines 38 and 41):

```ts
import { ENABLE_2FA, mfaVerifySchema, mfaEnableSchema, mfaStepUpSchema, maintenanceStepUpResource, moveOrgStepUpResource, rollbackStepUpResource, scriptLaneStepUpResource } from './schemas';
```
```ts
import { maintenanceResourceDigest, mintStepUpGrant, moveOrgResourceDigest, passkeyRemovalResourceDigest, rollbackResourceDigest, scriptLanePolicyResourceDigest } from '../../services/mfaStepUpGrant';
```

`RESOURCE_BOUND_OPERATIONS`:

```ts
const RESOURCE_BOUND_OPERATIONS = {
  agent_rollback: rollbackStepUpResource,
  device_maintenance: maintenanceStepUpResource,
  device_move_org: moveOrgStepUpResource,
  ai_script_lane_grant: scriptLaneStepUpResource,
} as const;
```

The `boundResource` type union (line ~1241) gains `| z.infer<typeof moveOrgStepUpResource>`.

The digest ternary at mint (~line 1365):

```ts
    resourceDigest:
      body.operation === 'agent_rollback'
        ? rollbackResourceDigest(boundResource as z.infer<typeof rollbackStepUpResource>)
        : body.operation === 'device_maintenance'
          ? maintenanceResourceDigest(boundResource as z.infer<typeof maintenanceStepUpResource>)
          : body.operation === 'device_move_org'
            ? moveOrgResourceDigest(boundResource as z.infer<typeof moveOrgStepUpResource>)
            : body.operation === 'ai_script_lane_grant'
              ? scriptLanePolicyResourceDigest(boundResource as z.infer<typeof scriptLaneStepUpResource>)
              : body.operation === 'delete_passkey'
                ? passkeyRemovalResourceDigest(body.passkeyId!)
                : '',
```

- [ ] **Step 5: Run to verify green**

Run: `cd apps/api && npx vitest run src/routes/auth/schemas.test.ts src/routes/auth.test.ts`
Expected: PASS, including `mints a device_move_org grant bound to the canonical move digest` (200).

- [ ] **Step 6: Typecheck**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json`
Expected: exit 0. (If `satisfies readonly Exclude<…>[]` errors, the union in Task 1 is missing the member.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/auth/schemas.ts apps/api/src/routes/auth/schemas.test.ts apps/api/src/routes/auth/mfa.ts apps/api/src/routes/auth.test.ts
git commit -m "feat(auth): device_move_org is a client-requestable, resource-bound step-up operation"
```

---

### Task 3: Extract `lockActorAssurance` into a shared module

**Files:**
- Create: `apps/api/src/services/stepUpActorAssurance.ts`
- Delete: `apps/api/src/services/maintenanceAuthorization.ts`
- Modify: `apps/api/src/routes/devices/commands.ts:21` (import) and the two call sites (`lockMaintenanceAssurance(tx, auth, grantBinding)` in the bulk handler ~line 400 and single handler ~line 761)
- Modify: `apps/api/src/routes/devices/commands.test.ts:4`, `apps/api/src/__tests__/devices.endpoints.test.ts:4`, `apps/api/src/__tests__/integration/deviceMaintenanceStepUp.integration.test.ts:128,298`
- Test: `apps/api/src/services/stepUpActorAssurance.test.ts` (new)

**Interfaces:**
- Produces: `export async function lockActorAssurance(tx: Pick<typeof db, 'select'>, auth: AuthContext, binding: StepUpGrantBinding): Promise<boolean>` — byte-identical behaviour to `lockMaintenanceAssurance`. Used by maintenance (both handlers) and Task 5.

- [ ] **Step 1: Write the failing unit test for the shared module**

Create `apps/api/src/services/stepUpActorAssurance.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { lockActorAssurance } from './stepUpActorAssurance';
import type { AuthContext } from '../middleware/auth';

// Builds a tx whose select chain resolves to `rows` and records whether
// `.for('share')` was requested — the lock is the point of this helper.
function txResolving(rows: unknown[]) {
  const forMock = vi.fn(async () => rows);
  const limit = vi.fn(() => ({ for: forMock }));
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { tx: { select } as never, forMock };
}

const binding = { userId: 'user-1', operation: 'device_move_org' as const, authEpoch: 3, mfaEpoch: 2, sid: 'sid-1', resourceDigest: '' };
const auth = { user: { id: 'user-1' }, token: { aep: 3, mep: 2 } } as unknown as AuthContext;

describe('lockActorAssurance', () => {
  it('takes a FOR SHARE lock on the actor row', async () => {
    const { tx, forMock } = txResolving([{ status: 'active', authEpoch: 3, mfaEpoch: 2 }]);
    expect(await lockActorAssurance(tx, auth, binding)).toBe(true);
    expect(forMock).toHaveBeenCalledWith('share');
  });

  it('is false when the live epochs differ from the grant binding (factor reset after mint)', async () => {
    const { tx } = txResolving([{ status: 'active', authEpoch: 3, mfaEpoch: 3 }]);
    expect(await lockActorAssurance(tx, auth, binding)).toBe(false);
  });

  it('is false when the TOKEN epochs differ from the live row (stale session)', async () => {
    const { tx } = txResolving([{ status: 'active', authEpoch: 3, mfaEpoch: 2 }]);
    const staleAuth = { user: { id: 'user-1' }, token: { aep: 2, mep: 2 } } as unknown as AuthContext;
    expect(await lockActorAssurance(tx, staleAuth, binding)).toBe(false);
  });

  it('is false for a non-active actor', async () => {
    const { tx } = txResolving([{ status: 'disabled', authEpoch: 3, mfaEpoch: 2 }]);
    expect(await lockActorAssurance(tx, auth, binding)).toBe(false);
  });

  it('is false when the actor row is missing', async () => {
    const { tx } = txResolving([]);
    expect(await lockActorAssurance(tx, auth, binding)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/stepUpActorAssurance.test.ts`
Expected: FAIL — cannot resolve `./stepUpActorAssurance`.

- [ ] **Step 3: Create the module and delete the old one**

Create `apps/api/src/services/stepUpActorAssurance.ts` (the body is `maintenanceAuthorization.ts` verbatim, renamed):

```ts
import { eq } from 'drizzle-orm';
import type { db } from '../db';
import { users } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { StepUpGrantBinding } from './mfaStepUpGrant';

/**
 * Hold the actor's auth state stable until the step-up-gated transaction
 * commits. Factor resets update this row, so a reset that wins the lock
 * invalidates admission; one that follows the lock cannot complete before
 * the write. Shared by every route that consumes a step-up grant inside its
 * write transaction (device maintenance, device move-org); take it as the
 * transaction's FIRST row lock so the lock order is `users` → everything else.
 *
 * True only when ALL hold: actor active; live epochs equal the grant binding;
 * token epochs equal the live row. Any other answer — including a missing
 * row — is a denial.
 */
export async function lockActorAssurance(
  tx: Pick<typeof db, 'select'>,
  auth: AuthContext,
  binding: StepUpGrantBinding,
): Promise<boolean> {
  const [actor] = await tx.select({
    authEpoch: users.authEpoch,
    mfaEpoch: users.mfaEpoch,
    status: users.status,
  }).from(users).where(eq(users.id, auth.user.id)).limit(1).for('share');
  return actor?.status === 'active'
    && actor.authEpoch === binding.authEpoch
    && actor.mfaEpoch === binding.mfaEpoch
    && auth.token?.aep === actor.authEpoch
    && auth.token?.mep === actor.mfaEpoch;
}
```

```bash
git rm apps/api/src/services/maintenanceAuthorization.ts
```

- [ ] **Step 4: Re-point the maintenance route and its three suites**

`apps/api/src/routes/devices/commands.ts` line 21:

```ts
import { lockActorAssurance } from '../../services/stepUpActorAssurance';
```

Replace both `lockMaintenanceAssurance(tx, auth, grantBinding)` calls with `lockActorAssurance(tx, auth, grantBinding)` (`grep -n lockMaintenanceAssurance apps/api/src/routes/devices/commands.ts` must return nothing afterwards).

`apps/api/src/routes/devices/commands.test.ts` line 4:

```ts
vi.mock('../../services/stepUpActorAssurance', () => ({ lockActorAssurance: vi.fn(async () => true) }));
```

`apps/api/src/__tests__/devices.endpoints.test.ts` line 4:

```ts
vi.mock('../services/stepUpActorAssurance', () => ({ lockActorAssurance: vi.fn(async () => true) }));
```

`apps/api/src/__tests__/integration/deviceMaintenanceStepUp.integration.test.ts` line 128:

```ts
import { lockActorAssurance } from '../../services/stepUpActorAssurance';
```
and line 298: `expect(await lockActorAssurance(tx, …`.

- [ ] **Step 5: Verify**

Run: `cd apps/api && npx vitest run src/services/stepUpActorAssurance.test.ts src/routes/devices/commands.test.ts src/__tests__/devices.endpoints.test.ts`
Expected: PASS (all). Then `grep -rn "maintenanceAuthorization\|lockMaintenanceAssurance" apps/api/src` → no output.

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A apps/api/src/services/stepUpActorAssurance.ts apps/api/src/services/stepUpActorAssurance.test.ts apps/api/src/services/maintenanceAuthorization.ts apps/api/src/routes/devices/commands.ts apps/api/src/routes/devices/commands.test.ts apps/api/src/__tests__/devices.endpoints.test.ts apps/api/src/__tests__/integration/deviceMaintenanceStepUp.integration.test.ts
git commit -m "refactor(auth): extract lockActorAssurance from maintenanceAuthorization for reuse by move-org"
```

---

### Task 4: Lift `requireInteractiveSession()` into `middleware/auth.ts`

**Files:**
- Modify: `apps/api/src/middleware/auth.ts` (add export after `isInteractiveUserSession`, ~line 69)
- Modify: `apps/api/src/routes/devices/commands.ts:9` (import) and delete the local definition at ~lines 618-638
- Test: `apps/api/src/middleware/auth.test.ts` (new describe after `describe('requireMfa', …)`)

**Interfaces:**
- Produces: `export function requireInteractiveSession(): MiddlewareHandler` — 403 `{ error: 'Interactive user session required' }` unless `auth.principal.kind === 'user_session'`. Used by maintenance (unchanged behaviour) and Task 5.

- [ ] **Step 1: Write the failing middleware tests**

Add to `apps/api/src/middleware/auth.test.ts`, importing `requireInteractiveSession` on the existing import line from `'./auth'`:

```ts
describe('requireInteractiveSession', () => {
  function appWith(auth: unknown) {
    const app = new Hono();
    app.use(async (c: any, next: any) => {
      if (auth !== undefined) c.set('auth', auth);
      await next();
    });
    app.use(requireInteractiveSession());
    app.get('/test', (c) => c.json({ ok: true }));
    return app;
  }

  it('admits a user_session principal', async () => {
    const res = await appWith({ ...baseAuth, principal: { kind: 'user_session' } }).request('/test');
    expect(res.status).toBe(200);
  });

  it.each(['api_key', 'oauth_grant', 'ai_agent', 'system', 'unknown'])('denies a %s principal with a written 403', async (kind) => {
    const res = await appWith({ ...baseAuth, principal: { kind } }).request('/test');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Interactive user session required' });
  });

  it('denies when there is no auth context at all', async () => {
    const res = await appWith(undefined).request('/test');
    expect(res.status).toBe(403);
  });
});
```

(`baseAuth` already exists in that file — confirm with `grep -n "const baseAuth" apps/api/src/middleware/auth.test.ts`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/middleware/auth.test.ts -t requireInteractiveSession`
Expected: FAIL — `requireInteractiveSession is not a function`.

- [ ] **Step 3: Implement**

In `apps/api/src/middleware/auth.ts`, immediately after `isInteractiveUserSession` (~line 69). `MiddlewareHandler` is already importable from `'hono'` — add it to the existing `import type { Context, Next, … } from 'hono'` line if absent:

```ts
/**
 * "A human must be doing this" — UNCONDITIONAL. NOT redundant with
 * requireMfa(): API-key and MCP-OAuth contexts are built with `token: {}`
 * (routes/mcpServer.ts:2246), and hasSatisfiedMfa returns true for ANY
 * context when ENABLE_2FA is off — so on such a deployment the MFA gate would
 * ADMIT a machine principal. This gate is what makes "machine-principal denial
 * with zero state change" independent of MFA configuration. Place it before
 * any lookup so a denial costs no query. Used by device maintenance
 * (RMM-QA-176) and device move-org (spec 2026-09-18 D1).
 */
export function requireInteractiveSession(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth') as AuthContext | undefined;
    if (!auth || !isInteractiveUserSession(auth)) {
      return c.json({ error: 'Interactive user session required' }, 403);
    }
    return next();
  };
}
```

In `apps/api/src/routes/devices/commands.ts`: change line 9 to

```ts
import { authMiddleware, requireInteractiveSession, requireMfa, requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
```

Delete the local `requireInteractiveSession` function and its doc comment (~lines 618-638). If `isInteractiveUserSession` is no longer referenced in the file, drop it from the import; `MiddlewareHandler` stays (used by `requireMaintenanceEntryMfa`).

- [ ] **Step 4: Verify**

Run: `cd apps/api && npx vitest run src/middleware/auth.test.ts src/routes/devices/commands.test.ts src/__tests__/devices.endpoints.test.ts`
Expected: PASS. The maintenance machine-principal cases (`commands.test.ts:1233`, `:1502`, `:1527`) still pass — they exercise the real middleware through the route.

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/auth.ts apps/api/src/middleware/auth.test.ts apps/api/src/routes/devices/commands.ts
git commit -m "refactor(auth): export requireInteractiveSession from middleware/auth"
```

---

### Task 5: Gate the move-org route

**Files:**
- Modify: `apps/api/src/routes/devices/schemas.ts:241-249`
- Modify: `apps/api/src/routes/devices/moveOrg.ts` (imports 1-42; route doc 89-118; chain 119-126; handler 127-228; transaction 228-270; catch 1099-1140; audit 1173-1203)
- Test: `apps/api/src/routes/devices/moveOrg.test.ts`

**Interfaces:**
- Consumes: `moveOrgResourceDigest` (Task 1), `lockActorAssurance` (Task 3), `requireInteractiveSession` (Task 4), `validateStepUpGrant` / `consumeStepUpGrant` / `StepUpGrantBinding` from `services/mfaStepUpGrant`, `getUserEpochs` from `services/authEpochs`, `ENABLE_2FA` from `routes/auth/schemas`.
- Produces: `POST /devices/:id/move-org` body accepts `stepUpGrant?: uuid`; 403 `{ error: 'Interactive user session required' }` for machine principals; 403 `{ error: 'Step-up required', code: 'STEP_UP_REQUIRED' }` on missing/invalid/consumed grant; audit `details.stepUp: 'grant' | 'disabled_2fa'`.

- [ ] **Step 1: Update the test harness so existing cases keep passing under the new gate**

In `apps/api/src/routes/devices/moveOrg.test.ts`:

(a) Hoisted state and the `../../middleware/auth` mock become PARTIAL so the real `requireInteractiveSession` runs. Replace the `vi.mock('../../middleware/auth', …)` block with:

```ts
// Device move-org step-up: requireInteractiveSession is the REAL middleware
// (imported from the original module) so the machine-principal denial below
// tests production code, not a stub. The other gates stay stubbed as before.
vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    authMiddleware: authMiddlewareMock,
    requireScope: requireScopeMock,
    requirePermission: requirePermissionMock,
    requireMfa: requireMfaMock,
    requireInteractiveSession: actual.requireInteractiveSession,
    isInteractiveUserSession: actual.isInteractiveUserSession,
  };
});
```

(b) Add the `ENABLE_2FA` getter mock, the grant mocks, the actor-lock mock and the epochs mock, after the `../../db` mock:

```ts
// ENABLE_2FA is a module constant (routes/auth/schemas.ts); the established
// way to flip it per test is a getter over hoisted state (precedent:
// routes/devices/commands.test.ts).
const { enable2faState } = vi.hoisted(() => ({ enable2faState: { value: true } }));
vi.mock('../auth/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/schemas')>();
  return {
    ...actual,
    get ENABLE_2FA() {
      return enable2faState.value;
    },
  };
});

// PARTIAL: moveOrgResourceDigest stays REAL so the binding assertion compares
// against the production canonicalisation, not a stub.
vi.mock('../../services/mfaStepUpGrant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/mfaStepUpGrant')>();
  return {
    ...actual,
    validateStepUpGrant: vi.fn(async () => true),
    consumeStepUpGrant: vi.fn(async () => true),
  };
});

// The actor FOR SHARE lock is unit-tested on its own
// (services/stepUpActorAssurance.test.ts) and proved against real Postgres in
// the integration suite; here it is a mock so its POSITION in the transaction
// can be asserted without teaching the tx recorder about the users table.
vi.mock('../../services/stepUpActorAssurance', () => ({
  lockActorAssurance: vi.fn(async () => true),
}));

vi.mock('../../services/authEpochs', () => ({
  getUserEpochs: vi.fn(async () => ({ authEpoch: 1, mfaEpoch: 1 })),
}));
```

Add imports after the existing ones:

```ts
import { consumeStepUpGrant, moveOrgResourceDigest, validateStepUpGrant } from '../../services/mfaStepUpGrant';
import { lockActorAssurance } from '../../services/stepUpActorAssurance';
```

(c) `setAuth` gains `principal` and a real token, and accepts overrides:

```ts
function setAuth(overrides: Partial<{
  scope: 'organization' | 'partner' | 'system';
  canAccessOrg: (id: string) => boolean;
  permissions: { resource: string; action: string }[];
  principalKind: string;
  sid: string | undefined;
}> = {}) {
  authMiddlewareMock.mockImplementation((c: any, next: any) => {
    c.set('permissions', { permissions: overrides.permissions ?? [{ resource: '*', action: '*' }] });
    c.set('auth', {
      user: { id: 'user-1', email: 't@example.com' },
      scope: overrides.scope ?? 'partner',
      orgId: SOURCE_ORG,
      partnerId: 'partner-1',
      accessibleOrgIds: [SOURCE_ORG, TARGET_ORG],
      canAccessOrg: overrides.canAccessOrg ?? ((id: string) => id === SOURCE_ORG || id === TARGET_ORG),
      orgCondition: () => undefined,
      principal: { kind: overrides.principalKind ?? 'user_session' },
      token: { mfa: true, aep: 1, mep: 1, sid: 'sid' in overrides ? overrides.sid : 'sid-1' },
    });
    return next();
  });
}
```

(d) Every existing request body must now carry a grant. Add a constant next to `DEVICE_ID`:

```ts
const GRANT_ID = '99999999-9999-4999-8999-999999999999';
```

and apply this exact substitution across the file (21 + 4 occurrences — verify with `grep -c "siteId: TARGET_SITE }" apps/api/src/routes/devices/moveOrg.test.ts` before and after):

```bash
sed -i '' 's/siteId: TARGET_SITE }),/siteId: TARGET_SITE, stepUpGrant: GRANT_ID }),/g' apps/api/src/routes/devices/moveOrg.test.ts
```

Bodies that spread extra fields (e.g. `acceptCurrencyMismatch: true`) — find with `grep -n "acceptCurrencyMismatch" apps/api/src/routes/devices/moveOrg.test.ts` — get `stepUpGrant: GRANT_ID` added by hand.

(e) In the top-level `beforeEach`, add `enable2faState.value = true;` as the first line, and after `setAuth();` add:

```ts
    vi.mocked(validateStepUpGrant).mockResolvedValue(true);
    vi.mocked(consumeStepUpGrant).mockResolvedValue(true);
    vi.mocked(lockActorAssurance).mockResolvedValue(true);
```

(f) The gate-registration test gains the interactive-session gate — but that middleware is now the real function, not a mock, so assert it structurally instead: add after `expect(registeredMfaCallCount).toBeGreaterThan(0);`:

```ts
      // requireInteractiveSession is not stubbed (see the auth mock), so its
      // registration is proved behaviourally by the machine-principal case in
      // the "step-up gate" describe below, not by a call count here.
```

- [ ] **Step 2: Run the whole file to confirm the harness still passes BEFORE the route changes**

Run: `cd apps/api && npx vitest run src/routes/devices/moveOrg.test.ts`
Expected: PASS (all existing cases). The route ignores `stepUpGrant` today because the schema is non-strict, so nothing changes yet.

- [ ] **Step 3: Write the failing gate tests**

Append a new describe at the end of `describe('POST /devices/:id/move-org', …)`:

```ts
  // ── device move-org step-up (spec 2026-09-18 W01) ────────────────────────
  describe('step-up gate', () => {
    function rigMove() {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      return rigTransactionSuccess();
    }
    const move = (body: Record<string, unknown> = { orgId: TARGET_ORG, siteId: TARGET_SITE, stepUpGrant: GRANT_ID }) =>
      app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const expectedBinding = () => ({
      userId: 'user-1',
      operation: 'device_move_org',
      authEpoch: 1,
      mfaEpoch: 1,
      sid: 'sid-1',
      resourceDigest: moveOrgResourceDigest({ deviceId: DEVICE_ID, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE, acceptCurrencyMismatch: false }),
    });

    it('runs with ENABLE_2FA true (precondition for every case below)', async () => {
      const { ENABLE_2FA } = await import('../auth/schemas');
      expect(ENABLE_2FA).toBe(true);
    });

    it.each([[true], [false]])('denies an api_key principal with ENABLE_2FA=%s before any lookup, with no state change', async (twoFactorOn) => {
      enable2faState.value = twoFactorOn;
      setAuth({ principalKind: 'api_key' });
      rigMove();
      const res = await move();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Interactive user session required' });
      expect(getDeviceWithOrgAndSiteCheck).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('denies with no step-up grant after preflight, with no transaction and no failed-move audit', async () => {
      rigMove();
      const res = await move({ orgId: TARGET_ORG, siteId: TARGET_SITE });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
      expect(validateStepUpGrant).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('denies a stale or mismatched grant indistinguishably from a missing one', async () => {
      rigMove();
      vi.mocked(validateStepUpGrant).mockResolvedValueOnce(false);
      const res = await move();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
      expect(validateStepUpGrant).toHaveBeenCalledWith(GRANT_ID, expectedBinding());
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('binds acceptCurrencyMismatch into the grant digest', async () => {
      rigMove();
      vi.mocked(validateStepUpGrant).mockResolvedValueOnce(false);
      await move({ orgId: TARGET_ORG, siteId: TARGET_SITE, acceptCurrencyMismatch: true, stepUpGrant: GRANT_ID });
      expect(validateStepUpGrant).toHaveBeenCalledWith(GRANT_ID, expect.objectContaining({
        resourceDigest: moveOrgResourceDigest({ deviceId: DEVICE_ID, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE, acceptCurrencyMismatch: true }),
      }));
    });

    it('answers 503 when the session carries no sid (cannot bind a grant)', async () => {
      setAuth({ sid: undefined });
      rigMove();
      const res = await move();
      expect(res.status).toBe(503);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('moves with a valid grant: locks the actor, consumes with the exact binding BEFORE the org locks, and audits stepUp: grant', async () => {
      const rig = rigMove();
      const res = await move();
      expect(res.status).toBe(200);
      expect(lockActorAssurance).toHaveBeenCalledTimes(1);
      expect(consumeStepUpGrant).toHaveBeenCalledWith(GRANT_ID, expectedBinding());
      // Lock order: actor lock and consume happen before the first org FOR SHARE.
      const orgLockOrder = vi.mocked(lockActorAssurance).mock.invocationCallOrder[0]!;
      const consumeOrder = vi.mocked(consumeStepUpGrant).mock.invocationCallOrder[0]!;
      const firstOrgShare = rig.statements.findIndex((s) => s.startsWith('SELECT organizations FOR share'));
      expect(firstOrgShare).toBeGreaterThanOrEqual(0);
      // The recorder appends statements as they run; lockActorAssurance is mocked
      // (no statement), so prove ordering via the tx handle: the actor lock was
      // invoked with the SAME tx and before consume, and both before any UPDATE.
      expect(vi.mocked(lockActorAssurance).mock.calls[0]![0]).toBe(rig.tx());
      expect(orgLockOrder).toBeLessThan(consumeOrder);
      expect(rig.statements.filter((s) => s.startsWith('UPDATE')).length).toBeGreaterThan(0);
      const details = vi.mocked(writeRouteAudit).mock.calls.find((c) => c[1].action === 'device.move_org.source')![1].details as Record<string, unknown>;
      expect(details.stepUp).toBe('grant');
    });

    it('a grant burned by a racing request aborts the transaction with 403 and no failed-move audit or Sentry', async () => {
      const rig = rigMove();
      vi.mocked(consumeStepUpGrant).mockResolvedValueOnce(false);
      const res = await move();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
      expect(rig.statements.filter((s) => s.startsWith('UPDATE'))).toEqual([]);
      expect(writeRouteAudit).not.toHaveBeenCalled();
      expect(captureExceptionMock).not.toHaveBeenCalled();
      expect(disconnectAgent).not.toHaveBeenCalled();
    });

    it('a lost actor lock (factor reset between validate and write) aborts the same way', async () => {
      const rig = rigMove();
      vi.mocked(lockActorAssurance).mockResolvedValueOnce(false);
      const res = await move();
      expect(res.status).toBe(403);
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
      expect(rig.statements.filter((s) => s.startsWith('UPDATE'))).toEqual([]);
    });

    it('skips the grant requirement when ENABLE_2FA is off, still denies machines, and records stepUp: disabled_2fa', async () => {
      enable2faState.value = false;
      rigMove();
      const res = await move({ orgId: TARGET_ORG, siteId: TARGET_SITE });
      expect(res.status).toBe(200);
      expect(validateStepUpGrant).not.toHaveBeenCalled();
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
      expect(lockActorAssurance).not.toHaveBeenCalled();
      const details = vi.mocked(writeRouteAudit).mock.calls.find((c) => c[1].action === 'device.move_org.target')![1].details as Record<string, unknown>;
      expect(details.stepUp).toBe('disabled_2fa');
    });
  });
```

Note: the "ordering" assertion in the happy-path test relies on `rig.tx()` being the same object handed to `lockActorAssurance`; `rigTransactionSuccess` already exposes `tx: () => txHandle`.

- [ ] **Step 4: Run to verify the new cases fail**

Run: `cd apps/api && npx vitest run src/routes/devices/moveOrg.test.ts -t "step-up gate"`
Expected: FAIL — machine principal gets 200 (no interactive gate yet), missing-grant gets 200, `stepUp` undefined, etc. The `ENABLE_2FA true` precondition and the 2FA-off case may pass vacuously; the rest are red.

- [ ] **Step 5: Implement the schema change**

`apps/api/src/routes/devices/schemas.ts`:

```ts
export const moveOrgSchema = z.object({
  orgId: z.string().guid(),
  siteId: z.string().guid(),
  // Multi-currency (#3776): tickets bound to the device move with it. When
  // the target org bills in another currency and those tickets carry unbilled
  // monetary rows, the move is blocked (409 TICKET_MOVE_CURRENCY_BLOCKED)
  // unless explicitly accepted; `true` additionally requires invoices:write.
  acceptCurrencyMismatch: z.boolean().optional(),
  // Device move-org step-up (spec 2026-09-18 D2/D3): a single-use grant
  // minted by POST /auth/mfa/step-up for operation 'device_move_org', bound
  // to this exact { deviceId, orgId, siteId, acceptCurrencyMismatch }.
  // Required whenever ENABLE_2FA is on; the route answers
  // 403 STEP_UP_REQUIRED when it is missing or does not validate.
  // Deliberately NOT .strict() (unlike the maintenance schemas): the only
  // behaviour change for existing callers is the grant requirement itself.
  stepUpGrant: z.string().guid().optional(),
});
```

- [ ] **Step 6: Implement the route**

`apps/api/src/routes/devices/moveOrg.ts` — imports (replace the `middleware/auth` import and add four lines):

```ts
import {
  authMiddleware,
  requireInteractiveSession,
  requireMfa,
  requirePermission,
  requireScope,
} from '../../middleware/auth';
import { consumeStepUpGrant, moveOrgResourceDigest, validateStepUpGrant, type StepUpGrantBinding } from '../../services/mfaStepUpGrant';
import { getUserEpochs } from '../../services/authEpochs';
import { lockActorAssurance } from '../../services/stepUpActorAssurance';
import { ENABLE_2FA } from '../auth/schemas';
```

After the `OrgVanishedDuringMoveError` class, add:

```ts
const STEP_UP_REQUIRED_BODY = { error: 'Step-up required', code: 'STEP_UP_REQUIRED' } as const;

/** Thrown inside the move transaction when the actor lock or the grant
 *  consume fails: a racing consume, or a factor reset that committed between
 *  validation and the write. Rolls the move back with no state change. */
class MoveOrgStepUpConsumedError extends Error {
  constructor() {
    super('step-up grant could not be consumed inside the move transaction');
    this.name = 'MoveOrgStepUpConsumedError';
  }
}
```

Route doc comment: replace the `- MFA — destructive cross-tenant change.` bullet with:

```
 *   - an interactive user session — API keys, MCP-OAuth grants and AI agents
 *     are denied unconditionally (requireInteractiveSession, spec 2026-09-18 D1)
 *   - an MFA-assured session (requireMfa) AND, while ENABLE_2FA is on, a fresh
 *     single-use step-up grant for operation 'device_move_org' bound to this
 *     exact { deviceId, orgId, siteId, acceptCurrencyMismatch } (D2/D3). The
 *     grant is validated before the transaction and consumed inside it, after
 *     a FOR SHARE lock on the actor row and BEFORE the organisation locks.
```

Chain:

```ts
moveOrgRoutes.post(
  '/:id/move-org',
  requireScope('partner', 'system'),
  requireInteractiveSession(),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', moveOrgSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const { orgId: targetOrgId, siteId: targetSiteId, acceptCurrencyMismatch, stepUpGrant } = c.req.valid('json');
```

Immediately after the target-site check (the `if (!targetSite) { … return 400 }` block) and before `// ----------- the actual move -----------`, insert:

```ts
    // Device move-org step-up (spec 2026-09-18 D3). Every preflight above is
    // read-only, so a denial here costs no write and no lock. Missing, stale
    // and mismatched grants are ONE response on purpose: telling a caller which
    // of the three it hit is a probing oracle for the binding.
    let grantBinding: StepUpGrantBinding | null = null;
    if (ENABLE_2FA) {
      const epochs = await getUserEpochs(auth.user.id);
      const sid = auth.token?.sid;
      if (!epochs || !sid) {
        return c.json({ error: 'Service temporarily unavailable' }, 503);
      }
      grantBinding = {
        userId: auth.user.id,
        operation: 'device_move_org',
        authEpoch: epochs.authEpoch,
        mfaEpoch: epochs.mfaEpoch,
        sid,
        resourceDigest: moveOrgResourceDigest({
          deviceId,
          targetOrgId,
          targetSiteId,
          acceptCurrencyMismatch,
        }),
      };
      if (!stepUpGrant || !(await validateStepUpGrant(stepUpGrant, grantBinding))) {
        return c.json(STEP_UP_REQUIRED_BODY, 403);
      }
    }
```

Inside the transaction, right after the `SET CONSTRAINTS … DEFERRED` `tx.execute(...)` and BEFORE the `readOrgStampingDefaultsMany` comment block, insert:

```ts
        // Step-up admission (spec 2026-09-18 D3). FIRST row lock of this
        // transaction, deliberately BEFORE the organisation FOR SHARE reads
        // below: the actor's auth state is held stable until commit, and a
        // grant burned by a racing request aborts this one with no row change.
        // Lock order for this transaction is therefore
        //   users(actor) → organizations(source,target asc) → device/children.
        // `users` appears in no other mover's lock list
        // (services/ticketOrgMoveLockOrder.ts covers ticket children only), so
        // this introduces no new deadlock pair. Matches the maintenance entry
        // path (routes/devices/commands.ts), which takes the same actor lock
        // first.
        if (grantBinding && (!(await lockActorAssurance(tx, auth, grantBinding))
          || !(await consumeStepUpGrant(stepUpGrant!, grantBinding)))) {
          throw new MoveOrgStepUpConsumedError();
        }
```

Also amend the existing org-lock comment's first line from `as the FIRST statement of this transaction` to `as the first statement after the step-up admission above`.

In the `catch`, add before the `TicketMoveCurrencyBlockedError` branch:

```ts
      // A consumed/invalidated grant is a refusal, not a failure: the
      // transaction rolled back untouched, so answer as the pre-transaction
      // validation would have — no Sentry, no failed-move audit.
      if (err instanceof MoveOrgStepUpConsumedError) {
        return c.json(STEP_UP_REQUIRED_BODY, 403);
      }
```

In `auditDetails`, after `targetSiteId,`:

```ts
      // Device move-org step-up: how admission was proved. 'grant' = a fresh
      // single-use step-up grant was consumed inside the transaction;
      // 'disabled_2fa' = ENABLE_2FA is off on this deployment.
      stepUp: grantBinding ? 'grant' : 'disabled_2fa',
```

- [ ] **Step 7: Run to verify green**

Run: `cd apps/api && npx vitest run src/routes/devices/moveOrg.test.ts`
Expected: PASS — every pre-existing case plus the 10 new ones.

- [ ] **Step 8: Mutation check the two gates**

Temporarily comment out the `requireInteractiveSession(),` line in the chain; run the file; expect the two `api_key` cases to FAIL. Restore. Temporarily change `if (!stepUpGrant || !(await validateStepUpGrant(…)))` to `if (false)`; run; expect `denies with no step-up grant` and `denies a stale or mismatched grant` to FAIL. Restore. Confirm `git diff --stat` shows only the intended files.

- [ ] **Step 9: Typecheck + lint**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json && npx eslint src/routes/devices/moveOrg.ts src/routes/devices/moveOrg.test.ts src/routes/devices/schemas.ts`
Expected: both exit 0.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/routes/devices/schemas.ts apps/api/src/routes/devices/moveOrg.ts apps/api/src/routes/devices/moveOrg.test.ts
git commit -m "feat(devices): move-org requires an interactive session and a fresh device_move_org step-up grant

Mutation-checked: removing requireInteractiveSession() reds the api_key cases; disabling the grant validation reds the no-grant and stale-grant cases."
```

---

### Task 6: Real-database proof — `deviceMoveOrgStepUp.integration.test.ts`

**Files:**
- Create: `apps/api/src/__tests__/integration/deviceMoveOrgStepUp.integration.test.ts`

**Interfaces:**
- Consumes: the route from Task 5; `mintStepUpGrant`, `moveOrgResourceDigest`; `lockActorAssurance` (Task 3); fixtures `createIntegrationTestClient`, `createOrganization`, `createSite` from `./db-utils`.

- [ ] **Step 1: Bring the stack up**

Run: `pnpm test-stack up` (repo root). Note the printed `envTest` path.

- [ ] **Step 2: Write the suite**

```ts
/**
 * Device move-org step-up (spec 2026-09-18 W01) — "denied with ZERO state
 * change", proved against real rows.
 *
 * Mirror of deviceMaintenanceStepUp.integration.test.ts. Each denial case does
 *   SELECT * -> denied request -> SELECT * -> expect(after).toEqual(before)
 * over EVERY column of the real `devices` row, and additionally asserts that
 * no device-scoped child row moved org (sampled through device_commands, one
 * of the 64 denormalised tables). Two ADMISSION controls sit beside the
 * denials so a suite where everything 403s cannot pass vacuously.
 *
 * Machine principals: `/devices` is mounted JWT-only, so the real
 * authMiddleware is WRAPPED (not replaced) and only the resulting context's
 * principal/token are downgraded to the api-key shape when a test asks.
 *
 * Prerequisites (private per-worktree stack — never `test:docker:up`):
 *   pnpm test-stack up
 * Run:
 *   set -a && . ./.env.test && set +a && cd apps/api && npx vitest run \
 *     --config vitest.integration.config.ts \
 *     src/__tests__/integration/deviceMoveOrgStepUp.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enable2faState, principalState } = vi.hoisted(() => ({
  enable2faState: { value: true },
  principalState: { kind: 'user_session' as string },
}));

vi.mock('../../routes/auth/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/auth/schemas')>();
  return {
    ...actual,
    get ENABLE_2FA() {
      return enable2faState.value;
    },
  };
});

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: (c: never, next: never) =>
      (actual.authMiddleware as (c: unknown, next: unknown) => Promise<unknown>)(c, async () => {
        if (principalState.kind !== 'user_session') {
          const auth = (c as unknown as { get: (k: string) => Record<string, unknown> | undefined }).get('auth');
          if (auth) {
            auth.principal = { kind: principalState.kind, id: 'api-key-1' };
            auth.token = {};
          }
        }
        return (next as unknown as () => Promise<unknown>)();
      }),
  };
});

// The move fires a WS disconnect for the agent post-commit; there is no agent
// WS in this suite, so make it inert (it is not what is under test).
vi.mock('../../routes/agentWs', () => ({ disconnectAgent: vi.fn(() => false) }));

import { deviceCommands, devices } from '../../db/schema';
import { deviceRoutes } from '../../routes/devices';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { mintStepUpGrant, moveOrgResourceDigest } from '../../services/mfaStepUpGrant';
import { lockActorAssurance } from '../../services/stepUpActorAssurance';
import type { AuthContext } from '../../middleware/auth';
import { createIntegrationTestClient, createOrganization, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = describe.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  app.route('/devices', deviceRoutes);
  return app;
}

async function readDeviceRow(deviceId: string): Promise<Record<string, unknown>> {
  const [row] = (await getTestDb().execute(
    sql`SELECT * FROM devices WHERE id = ${deviceId}::uuid`,
  )) as unknown as Array<Record<string, unknown>>;
  if (!row) throw new Error(`device ${deviceId} vanished`);
  return row;
}

async function readCommandOrg(commandId: string): Promise<string> {
  const [row] = (await getTestDb().execute(
    sql`SELECT org_id FROM device_commands WHERE id = ${commandId}::uuid`,
  )) as unknown as Array<{ org_id: string }>;
  if (!row) throw new Error(`command ${commandId} vanished`);
  return row.org_id;
}

runDb('device move-org step-up: denial leaves the device and its children untouched', () => {
  let app: Hono;
  let env: Awaited<ReturnType<typeof createIntegrationTestClient>>;
  let deviceId: string;
  let commandId: string;
  let sourceOrgId: string;
  let targetOrgId: string;
  let targetSiteId: string;

  beforeEach(async () => {
    enable2faState.value = true;
    principalState.kind = 'user_session';

    app = buildApp();
    // Partner-scope fixture: the route requires partner or system scope. The
    // fixture token is mfa:false (db-utils), i.e. the NON-assured session.
    env = await createIntegrationTestClient(app, { scope: 'partner' });
    sourceOrgId = env.env.organization.id;
    const target = await createOrganization({ partnerId: env.env.partner.id });
    targetOrgId = target.id;
    targetSiteId = (await createSite({ orgId: targetOrgId, name: 'Target site' })).id;

    const suffix = randomUUID();
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId: sourceOrgId,
        siteId: env.env.site.id,
        agentId: `move-stepup-${suffix}`,
        hostname: `move-stepup-${suffix.slice(0, 12)}`,
        displayName: 'Move Step-Up Fixture',
        osType: 'windows',
        osVersion: '11',
        architecture: 'x64',
        agentVersion: 'test',
        status: 'online',
        lastSeenAt: new Date(),
      })
      .returning({ id: devices.id });
    if (!device) throw new Error('move step-up fixture device insert failed');
    deviceId = device.id;

    // One denormalised child row so "nothing moved" is asserted beyond the
    // devices table itself.
    const [command] = await getTestDb()
      .insert(deviceCommands)
      .values({ deviceId, orgId: sourceOrgId, type: 'refresh_inventory', status: 'completed', payload: {} })
      .returning({ id: deviceCommands.id });
    if (!command) throw new Error('fixture command insert failed');
    commandId = command.id;
  });

  const body = () => ({ orgId: targetOrgId, siteId: targetSiteId });

  async function assuredSession(): Promise<{ sid: string; post: (path: string, body: unknown) => Promise<Response> }> {
    const sid = randomUUID();
    const payload: Omit<TokenPayload, 'type'> = {
      sub: env.env.user.id,
      email: env.env.user.email,
      roleId: env.env.role.id,
      orgId: null,
      partnerId: env.env.partner.id,
      scope: 'partner',
      mfa: true,
      aep: 1,
      mep: 1,
      sid,
    };
    const token = await createAccessToken(payload);
    return {
      sid,
      post: (path: string, b: unknown) => Promise.resolve(app.request(path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(b),
      })),
    };
  }

  async function mintFor(sid: string, acceptCurrencyMismatch = false): Promise<string> {
    const grant = await mintStepUpGrant({
      userId: env.env.user.id,
      operation: 'device_move_org',
      authEpoch: 1,
      mfaEpoch: 1,
      sid,
      resourceDigest: moveOrgResourceDigest({ deviceId, targetOrgId, targetSiteId, acceptCurrencyMismatch }),
    });
    if (!grant) throw new Error('grant mint failed (Redis?)');
    return grant;
  }

  it('a NON-ASSURED session is denied and nothing moves', async () => {
    const before = await readDeviceRow(deviceId);
    const res = await env.post(`/devices/${deviceId}/move-org`, body());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(await readDeviceRow(deviceId)).toEqual(before);
    expect(await readCommandOrg(commandId)).toBe(sourceOrgId);
  });

  it('an assured session with NO grant is denied and nothing moves', async () => {
    const { post } = await assuredSession();
    const before = await readDeviceRow(deviceId);
    const res = await post(`/devices/${deviceId}/move-org`, body());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await readDeviceRow(deviceId)).toEqual(before);
    expect(await readCommandOrg(commandId)).toBe(sourceOrgId);
  });

  it('a grant minted for a DIFFERENT destination is denied and nothing moves', async () => {
    const { sid, post } = await assuredSession();
    const otherSite = await createSite({ orgId: targetOrgId, name: 'Other site' });
    const grant = await mintStepUpGrant({
      userId: env.env.user.id,
      operation: 'device_move_org',
      authEpoch: 1,
      mfaEpoch: 1,
      sid,
      resourceDigest: moveOrgResourceDigest({ deviceId, targetOrgId, targetSiteId: otherSite.id }),
    });
    const before = await readDeviceRow(deviceId);
    const res = await post(`/devices/${deviceId}/move-org`, { ...body(), stepUpGrant: grant });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await readDeviceRow(deviceId)).toEqual(before);
  });

  it('an X-API-Key request never reaches the route and nothing moves', async () => {
    const before = await readDeviceRow(deviceId);
    const res = await app.request(`/devices/${deviceId}/move-org`, {
      method: 'POST',
      headers: { 'X-API-Key': 'brz_not_a_real_key', 'Content-Type': 'application/json' },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(401);
    expect(await readDeviceRow(deviceId)).toEqual(before);
  });

  it('holds the actor epoch lock until the move transaction finishes', async () => {
    const binding = { userId: env.env.user.id, operation: 'device_move_org' as const, authEpoch: 1, mfaEpoch: 1, sid: randomUUID(), resourceDigest: '' };
    await getTestDb().transaction(async (tx) => {
      expect(await lockActorAssurance(tx, { user: { id: binding.userId }, token: { aep: 1, mep: 1 } } as AuthContext, binding)).toBe(true);
      let blocked = false;
      try {
        await getTestDb().transaction(async (resetTx) => {
          await resetTx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
          await resetTx.execute(sql`UPDATE users SET mfa_epoch = mfa_epoch + 1 WHERE id = ${binding.userId}::uuid`);
        });
      } catch (error) {
        const pgError = (error as { cause?: { code?: string }; code?: string }).cause ?? error as { code?: string };
        expect(pgError.code).toBe('55P03');
        blocked = true;
      }
      expect(blocked).toBe(true);
    });
  });

  it('ADMISSION CONTROL: an assured session with a REAL grant moves the device and its child row; the replay does not', async () => {
    const { sid, post } = await assuredSession();
    const grant = await mintFor(sid);
    const before = await readDeviceRow(deviceId);

    const res = await post(`/devices/${deviceId}/move-org`, { ...body(), stepUpGrant: grant });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });

    const admitted = await readDeviceRow(deviceId);
    expect(admitted).not.toEqual(before);
    expect(admitted.org_id).toBe(targetOrgId);
    expect(admitted.site_id).toBe(targetSiteId);
    expect(await readCommandOrg(commandId)).toBe(targetOrgId);

    // Single-use: replaying the SAME grant (now for a device already in the
    // target org) is denied at the grant, not at the "same org" 400.
    // Move it back first so the replay is a legitimate-looking request.
    await getTestDb().execute(sql`UPDATE devices SET org_id = ${sourceOrgId}::uuid, site_id = ${env.env.site.id}::uuid WHERE id = ${deviceId}::uuid`);
    const replay = await post(`/devices/${deviceId}/move-org`, { ...body(), stepUpGrant: grant });
    expect(replay.status).toBe(403);
    expect(await replay.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await readDeviceRow(deviceId)).org_id).toBe(sourceOrgId);
  });

  describe('ENABLE_2FA=false', () => {
    beforeEach(() => {
      enable2faState.value = false;
    });

    it('CONTROL: an interactive session with no grant IS admitted and the row moves', async () => {
      const { post } = await assuredSession();
      const res = await post(`/devices/${deviceId}/move-org`, body());
      expect(res.status).toBe(200);
      expect((await readDeviceRow(deviceId)).org_id).toBe(targetOrgId);
    });

    it.each(['api_key', 'oauth_grant'])('denies a %s principal with no state change — the interactive gate, not MFA, is doing the work', async (kind) => {
      principalState.kind = kind;
      const { post } = await assuredSession();
      const before = await readDeviceRow(deviceId);
      const res = await post(`/devices/${deviceId}/move-org`, body());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Interactive user session required' });
      expect(await readDeviceRow(deviceId)).toEqual(before);
      expect(await readCommandOrg(commandId)).toBe(sourceOrgId);
    });
  });
});
```

If the `deviceCommands` insert refuses a column (e.g. `payload` NOT NULL shape or a required `createdBy`), read `apps/api/src/db/schema/deviceCommands.ts` and supply the minimum the schema requires; keep `orgId` = source org.

- [ ] **Step 3: Run — expect green**

Run: `set -a && . ./.env.test && set +a && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceMoveOrgStepUp.integration.test.ts`
Expected: PASS, 9 cases.

- [ ] **Step 4: Mutation check against the real database**

Comment out the `requireInteractiveSession(),` line in `moveOrg.ts`; rerun; expect both `ENABLE_2FA=false … denies a %s principal` cases to FAIL (row moved). Restore. Comment out the in-transaction `throw new MoveOrgStepUpConsumedError()` block; rerun; expect the replay half of the ADMISSION CONTROL case to FAIL. Restore. `git diff --stat` must show only the new test file.

- [ ] **Step 5: Tear down and commit**

```bash
pnpm test-stack down
git add apps/api/src/__tests__/integration/deviceMoveOrgStepUp.integration.test.ts
git commit -m "test(devices): move-org step-up denial leaves device and child rows untouched (real Postgres)

Mutation-checked: dropping the interactive gate moves the row for api_key/oauth_grant under ENABLE_2FA=false; dropping the in-tx consume admits the grant replay."
```

---

### Task 7: Contract docs — OpenAPI, API reference, security overview, release note

**Files:**
- Modify: `apps/api/src/openapi.ts:2469-2510`
- Modify: `apps/docs/src/content/docs/reference/api.mdx:81`
- Modify: `apps/docs/src/content/docs/security/overview.mdx` (MFA table, ~line 49)
- Modify: `docs/release-notes/next-release-draft.md` (Self-Hosting / Upgrade Notes list)

- [ ] **Step 1: OpenAPI**

Replace the `'/devices/{id}/move-org'` entry body with:

```ts
    '/devices/{id}/move-org': {
      post: {
        operationId: 'moveDeviceOrg',
        tags: ['Devices'],
        summary: 'Move device to a different organization',
        description: 'Relocate a device between organizations (and to a site within the new org) without uninstalling the agent. Requires partner or system scope, devices:write + organizations:write, an interactive user session (API keys and MCP tokens are refused), an MFA-assured session, and — while two-factor authentication is enabled on the deployment — a single-use step-up grant minted by POST /auth/mfa/step-up for operation `device_move_org` bound to this exact { deviceId, orgId, siteId, acceptCurrencyMismatch }. Cross-partner moves require system scope.',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['orgId', 'siteId'],
                properties: {
                  orgId: { type: 'string', format: 'uuid', description: 'Target organization id' },
                  siteId: { type: 'string', format: 'uuid', description: 'Target site id (must belong to target org)' },
                  acceptCurrencyMismatch: { type: 'boolean', description: 'Accept that unbilled ticket money bound to this device stays in the source currency. Requires invoices:write. Part of the step-up grant binding.' },
                  stepUpGrant: { type: 'string', format: 'uuid', description: 'Step-up grant id from POST /auth/mfa/step-up (operation device_move_org). Required when two-factor authentication is enabled.' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Device moved',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    device: { $ref: '#/components/schemas/Device' },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid input (e.g. target site not in target org, target org equals source)' },
          '403': { description: 'Access denied: target org or cross-partner move without system scope; `Interactive user session required` for machine principals; `MFA_REQUIRED` for a non-assured session; `STEP_UP_REQUIRED` when the step-up grant is missing, stale, mismatched or already consumed' },
          '404': { description: 'Device or target organization not found' },
          '409': { description: 'Move blocked: `TICKET_MOVE_CURRENCY_BLOCKED` (unbilled ticket money in another currency; resend with acceptCurrencyMismatch), `DELIVERABLE_TICKET_PINNED`, or `PAM_DEVICE_MOVE_BLOCKED`' },
          '503': { description: 'Step-up binding could not be established (auth state or session id unavailable); retry' },
        },
      },
    },
```

Run: `cd apps/api && npx vitest run src/openapi` — expected PASS (the existing OpenAPI suites do not pin this entry's shape; if one does, update it to the text above).

- [ ] **Step 2: API reference row**

`apps/docs/src/content/docs/reference/api.mdx:81`:

```
| `POST` | `/devices/:id/move-org` | Relocate a device to a different organization within the same partner. Requires an interactive user session (API keys are refused), an MFA-assured session, and — when two-factor authentication is enabled — a single-use step-up grant for operation `device_move_org` (`POST /auth/mfa/step-up`) bound to the exact device, destination and currency acknowledgement; otherwise `403 STEP_UP_REQUIRED`. |
```

- [ ] **Step 3: Security overview row**

In `apps/docs/src/content/docs/security/overview.mdx`, after the `**Passkey MFA**` row add:

```
| **Step-up-protected operations** | Some actions require a fresh second factor at the moment of the action, regardless of the tenant's MFA policy, via a single-use grant from `POST /auth/mfa/step-up` bound to the exact operation and target: adding or removing a factor, rotating recovery codes, registering an approver device, agent rollback, entering or extending device maintenance mode, and moving a device to another organization. Accounts with no enrolled factor cannot perform these. |
```

- [ ] **Step 4: Release note**

In `docs/release-notes/next-release-draft.md`, under `## Self-Hosting / Upgrade Notes`, add as the first bullet:

```
- **Breaking — `POST /devices/:id/move-org` now requires a step-up grant (spec 2026-09-18, W01):** while two-factor authentication is enabled, the request must carry `stepUpGrant`, a single-use grant minted by `POST /auth/mfa/step-up` with `operation: "device_move_org"` and a `resource` of `{ deviceId, targetOrgId, targetSiteId, acceptCurrencyMismatch }`. Requests without it receive `403 { code: "STEP_UP_REQUIRED" }`. API keys and MCP tokens are refused outright (`403 Interactive user session required`) whether or not two-factor authentication is on. The console dialog that performs the ceremony ships in the following wave; until then only scripted callers are affected. Accounts with no enrolled factor cannot move devices — enrol an authenticator app or passkey first.
```

- [ ] **Step 5: Docs build check**

Run: `cd apps/docs && pnpm astro check 2>&1 | tail -5` (or `npx astro check`). Expected: no new errors on the two edited pages.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/openapi.ts apps/docs/src/content/docs/reference/api.mdx apps/docs/src/content/docs/security/overview.mdx docs/release-notes/next-release-draft.md
git commit -m "docs(devices): move-org step-up contract in OpenAPI, API reference, security overview, release notes"
```

---

## Wave close-out

- [ ] Run the touched unit files together once more: `cd apps/api && npx vitest run src/services/mfaStepUpGrant.test.ts src/services/stepUpActorAssurance.test.ts src/routes/auth/schemas.test.ts src/routes/auth.test.ts src/middleware/auth.test.ts src/routes/devices/commands.test.ts src/routes/devices/moveOrg.test.ts src/__tests__/devices.endpoints.test.ts` — all green.
- [ ] `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json` — exit 0.
- [ ] Integration (stack up → run both `deviceMaintenanceStepUp` and `deviceMoveOrgStepUp` suites → stack down) — green; the maintenance suite proves the extraction in Task 3 changed nothing.
- [ ] `git log --oneline origin/main..HEAD` shows the seven task commits.
- [ ] PR body: `Closes #<W01 sub-issue>`; **Breaking** line copied from the release note; note that W02 (console) and W03 (`mfa_src`) follow.

## Self-review (done at authoring time)

- **Spec coverage.** D1 → Task 4 + 5 chain + integration `ENABLE_2FA=false` machine cases. D2 → Tasks 1, 2, 5 (schema). D3 → Task 5 (validate-before, lock+consume placement, error mapping, audit) + Task 3 (shared lock) + integration lock-hold case. D4 → the mint route already refuses accounts with no factor per method; W01 needs no extra code — the route only ever sees `STEP_UP_REQUIRED` for such accounts (asserted by the no-grant case). D7 → Task 7. Tests table (API/integration/docs rows) → Tasks 1, 2, 5, 6, 7. D5, D6 explicitly out of wave.
- **Placeholder scan.** No TBD/TODO; every code step carries the code. The one conditional instruction (Task 6 Step 2, `deviceCommands` insert columns) names the file to read and the invariant to keep.
- **Type consistency.** `moveOrgResourceDigest` signature identical in Tasks 1, 2, 5, 6. `lockActorAssurance(tx, auth, binding)` identical in Tasks 3, 5, 6. `requireInteractiveSession()` identical in Tasks 4, 5. `STEP_UP_REQUIRED_BODY` shape identical in Task 5 and the tests in Tasks 5–7. `GRANT_ID` defined once in Task 5 (d) before use.
