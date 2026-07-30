# M365 Communications-Delegated — Plan 1: API Binding & Runtime Config

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate and enforce the intent→connection binding that every later comms task depends on, and land the comms runtime config + boot validation — so both exist and are proven before the executor is written.

**Architecture:** Two API-side changes, neither of which needs the executor to exist. (1) `CreateActionIntentInput` gains an optional `binding` that populates the already-shipped, already-immutable `action_intents.connection_id` / `tenant_id` columns, and `revalidateApprovedIntentForRelease` gains a digest recompute from `intent.arguments`. (2) A `commsRuntimeConfig.ts` cloned from `writeActionRuntimeConfig.ts` with the allowlist axis swapped from orgs to **users**, wired into `config/validate.ts`.

**Tech Stack:** TypeScript, Hono (API), Drizzle ORM + Postgres (RLS), Vitest (unit + integration), `@breeze/shared` (canonicalizer, comms catalog).

## Global Constraints

- **Design spec:** `docs/superpowers/specs/integrations/2026-07-28-breeze-m365-communications-delegated-design.md`. This plan implements §14 tasks 6 and 7. Sections cited per task.
- **Owner axis is `user`, not `organization`.** Comms allowlists are UUID lists of **user** ids. Nothing may hardcode a single user even though v1 ships with one (§10).
- **The canonicalizer is shared and single.** Import from `@breeze/shared/canonicalize` (or the API re-export `services/actionIntents/canonicalize.ts`). A second implementation is a second canonicalization, and a digest scheme with two implementations has none (§5.2).
- **Digests on the release path are never recomputed as authority.** A claim recomputed while releasing, from the same envelope it is about to authorize, is a self-consistency check that always passes. The recompute added in Task 6 compares against the **stored** `intent.argumentDigest`; it is defense-in-depth against a write that bypassed the immutability trigger, nothing more (§5.2 item 5).
- **No new failure codes on the release path.** A recompute mismatch reuses the existing `digest_mismatch` code so audit/metrics semantics are unchanged.
- **`action_intents.tenant_id` is a Postgres `uuid` column** (`db/schema/actionIntents.ts:130`), while `m365_connections.tenant_id` is `VARCHAR(36)` with a lowercase-GUID CHECK. The binding must carry a canonical lowercase GUID or the INSERT raises `22P02`. Validate before insert; never let an unvalidated string reach a `uuid` column.
- **`connection_id` and `tenant_id` are already covered by the immutability trigger** (`2026-07-18-action-intents.sql:109-110`). No migration is needed in this plan. Do not add one.
- **Tests needing a real DB** run against Postgres on `:5433` via `vitest.integration.config.ts`. Unit tests mock Drizzle. Separate-config contract suites are NOT run by `pnpm test` — see the verification step in each task.
- **Never commit** real tenant ids, secrets, or infra hostnames.

**Baseline:** branch off `main` at `aeca40032`. Tasks 0–5 are shipped (see below); do not re-implement them.

---

## Already shipped — do not re-plan

| Task | PR | Squash | What landed |
|---|---|---|---|
| 0 | #2915 | `9e346eee9` | `principal` discriminator on `AuthContext`, 7-kind union, `isInteractiveUserSession` |
| 0a + 0b | #2917 | `fd32f8e73` | Durable-release-only guard for comms tools; immutable `origin_principal_kind`/`origin_principal_id` on `action_intents` |
| 1 | #2921 | `08adb1653` | Canonicalizer moved to `@breeze/shared`, cross-package frozen vectors |
| 2 | #2922 | `d4fd1ce53` | `commsActions.ts`, `commsEffect.ts`, `commsPlan.ts`, `commsPlanVectors.ts` |
| 3 | #2924 | `2e226a087` | `communications-delegated` profile v2, mail-only delegated scopes, `offline_access` retained |
| 4 | #2926 | `3c5c58271` | Migration `2026-08-06-f-m365-comms-delegated.sql`, `m365_user_consent_sessions`, delegated columns, RLS |
| 5 | #2928 | `617a18ead` | `m365CommsUserRls.integration.test.ts` — behavioural cross-user proof |

### Three corrections learned while shipping 4 and 5

These are not in §14 of the spec. They are binding on later tasks.

1. **The migration shipped as `apps/api/migrations/2026-08-06-f-m365-comms-delegated.sql`**, not `2026-07-28-a-m365-comms-delegated.sql` as §14 task 4 says. Cite the real filename.

2. **A new column on an org-cascade table must also be classified in `CORE_TENANT_EXPORT_POLICY`** (`apps/api/src/services/tenantExportPolicyRegistry.ts`) — a registration list CLAUDE.md did not document until `aeca40032`. It fires on a new **column**, not just a new table, and both enforcing suites need a live DB so neither can fail in the **Test API** job. Any later task adding a column to `m365_connections` or `action_intents` must register it. Buckets: plain identifiers and counters → `included`; suspicious-but-reviewed names → `reviewedIncluded`; credential material → `excludedSensitive`; **any `json`/`jsonb`/`bytea` column → `excludedOpen`**.

3. **The composite FK `m365_user_consent_sessions_connection_identity_fkey` has `ON DELETE CASCADE` but NO `ON UPDATE CASCADE`** — matching the shipped org-axis FK. Rotating `consent_attempt_id` on the parent therefore **raises an FK violation rather than cascading**. Verified against a real database, not assumed. **Plan 3's consent task must delete the attempt's session rows BEFORE rotating the attempt id, in the same locked transaction**, exactly as the org-axis flow does (`connectionService.ts:392-397` and `:727-731` call `deleteConsentSessionsForAttemptInTransaction` first). The blocking behaviour is the safer default: a missed cleanup fails loudly instead of orphaning a live `code_verifier`.

---

## Task Ordering & Dependencies

1. **Task 6 — Intent binding + release digest recompute.** Independent; needs nothing from Task 7.
2. **Task 7 — Comms runtime config + boot validation.** Independent; needs nothing from Task 6.

They may be done in either order or in parallel. Both are prerequisites for Plan 3 (Task 13's ladder consumes both). Plan 2 (the executor) consumes neither — it can start immediately.

Commit after every task.

---

### Task 6: Intent binding — populate the immutable columns, recompute the digest at release

Spec §5.2 ("Sender pinning (change 2)") and §5.2 item 5.

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentService.ts` — `CreateActionIntentInput` (line 65-75), the INSERT `.values({...})` block (~line 295-320)
- Modify: `apps/api/src/services/actionIntents/revalidateRelease.ts` — check (a), ~line 41-45
- Test: `apps/api/src/services/actionIntents/intentService.test.ts` (existing)
- Test: `apps/api/src/services/actionIntents/revalidateRelease.test.ts` — **CREATE. `revalidateRelease.ts` has no dedicated unit test today**; it is covered only indirectly through its two callers (`services/aiAgentSdk.test.ts`, `jobs/intentReleaseWorker*Headless.integration.test.ts`). There is no `intentFixture()` helper to reuse — Step 6 builds one.
- Test: `apps/api/src/__tests__/integration/actionIntentBinding.integration.test.ts` (create)

**⚠️ Known blast radius — a shipped fixture uses a fake digest and WILL fail.**
`jobs/intentReleaseWorker.test.ts:185` sets `argumentDigest: 'digest-1'`, which is not `sha256(canonicalize(arguments))` of anything. The recompute added in Step 8 turns **31 tests in that one file** red. That is the check working. Fix by hoisting the arguments and deriving the digest:

```ts
import { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';

const RUN_SCRIPT_ARGS = { scriptId: 'abc' };
const RUN_SCRIPT_DIGEST = computeArgumentDigest(canonicalizeArguments(RUN_SCRIPT_ARGS));
// then in baseIntent(): arguments: RUN_SCRIPT_ARGS, argumentDigest: RUN_SCRIPT_DIGEST,
```

**Do not weaken, skip, or conditionally bypass the recompute to keep a fixture green.** The `'stale-digest'` fixture at ~line 459 is the intended `digest_mismatch` case and must stay as it is.

`services/aiAgentSdk.test.ts:241` and `services/aiAgentSdk.planMatch.test.ts:118` also carry `argumentDigest: 'digest-1'`, but both suites mock `revalidateApprovedIntentForRelease` itself, so they never reach the recompute and stay green. Verified, not assumed — 102 passed. The worker *integration* suites already use a correct canonical digest (`intentReleaseWorkerM365Headless.integration.test.ts:20` says so explicitly).

**Interfaces:**
- Consumes: `canonicalizeArguments`, `computeArgumentDigest` from `./canonicalize` (already imported at `intentService.ts:12`); `ActionIntent` type from `db/schema/actionIntents`.
- Produces:
  - `CreateActionIntentInput.binding?: { connectionId: string; tenantId: string }` — consumed by Plan 3 Task 16 (`m365_send_mail` intent creation).
  - `revalidateApprovedIntentForRelease` unchanged signature: `(intent: ActionIntent, winningApproval: { boundArgumentDigest: string | null } | null) => Promise<IntentReleaseRevalidation>`. Consumed by `jobs/intentReleaseWorker.ts` and `services/aiAgentSdk.ts` — **do not change the signature**, both callers are shipped.

- [ ] **Step 1: Write the failing test for the binding on create**

Append to `apps/api/src/services/actionIntents/intentService.test.ts`:

```ts
describe('createActionIntent binding', () => {
  it('persists connectionId and tenantId when binding is supplied', async () => {
    const captured = captureInsertValues();          // existing helper in this file
    await createActionIntent(authFixture(), {
      toolName: 'm365_send_mail',
      input: { to: ['a@example.com'], subject: 's', bodyText: 'b' },
      source: 'chat',
      binding: {
        connectionId: '11111111-1111-4111-8111-111111111111',
        tenantId: '22222222-2222-4222-8222-222222222222',
      },
    });
    expect(captured.connectionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(captured.tenantId).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('leaves both columns null when binding is omitted', async () => {
    const captured = captureInsertValues();
    await createActionIntent(authFixture(), {
      toolName: 'execute_command',
      input: { command: 'whoami' },
      source: 'chat',
    });
    expect(captured.connectionId).toBeNull();
    expect(captured.tenantId).toBeNull();
  });

  it('rejects a non-canonical tenantId before it reaches the uuid column', async () => {
    // action_intents.tenant_id is a Postgres `uuid`; an uppercase or malformed
    // GUID raises 22P02 at INSERT. Fail in the service with a typed error.
    await expect(createActionIntent(authFixture(), {
      toolName: 'm365_send_mail',
      input: { to: ['a@example.com'], subject: 's', bodyText: 'b' },
      source: 'chat',
      binding: {
        connectionId: '11111111-1111-4111-8111-111111111111',
        tenantId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      },
    })).rejects.toThrow(/binding\.tenantId must be a canonical lowercase UUID/);
  });
});
```

If `captureInsertValues()` / `authFixture()` do not already exist in that file under those names, read the file's existing describe blocks and reuse whatever mock-capture helper it already uses — do not introduce a second mocking style.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter=@breeze/api exec vitest run src/services/actionIntents/intentService.test.ts -t 'binding'`
Expected: FAIL — `binding` is not a property of `CreateActionIntentInput` (TS error), and the columns are absent from the INSERT.

- [ ] **Step 3: Add `binding` to the input type**

In `intentService.ts`, inside `CreateActionIntentInput` (after `orgId?: string;`):

```ts
  /**
   * Pins the intent to the M365 connection whose credential will perform the
   * effect (design §5.2). Populates the already-immutable
   * `action_intents.connection_id` / `tenant_id` columns, which the release
   * path compares against the freshly-loaded connection on all four binding
   * fields. Absent for every non-comms tool, which is why it is optional.
   */
  binding?: { connectionId: string; tenantId: string };
```

- [ ] **Step 4: Validate and populate at the INSERT**

Above the `withSystemDbAccessContext` block (near where `argumentDigest` is computed, ~line 225):

```ts
  const CANONICAL_UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (input.binding) {
    // Both columns are Postgres `uuid`. An uppercase or malformed GUID would
    // raise 22P02 at INSERT, surfacing as a 500 rather than a validation
    // error, so reject it here.
    if (!CANONICAL_UUID_LOWER.test(input.binding.connectionId)) {
      throw new Error('binding.connectionId must be a canonical lowercase UUID');
    }
    if (!CANONICAL_UUID_LOWER.test(input.binding.tenantId)) {
      throw new Error('binding.tenantId must be a canonical lowercase UUID');
    }
  }
```

Then in the `.values({...})` block, alongside `originPrincipalKind`:

```ts
          connectionId: input.binding?.connectionId ?? null,
          tenantId: input.binding?.tenantId ?? null,
```

- [ ] **Step 5: Run the create tests to verify they pass**

Run: `pnpm --filter=@breeze/api exec vitest run src/services/actionIntents/intentService.test.ts -t 'binding'`
Expected: PASS (3 tests)

- [ ] **Step 6: Write the failing test for the release-time recompute**

Create `apps/api/src/services/actionIntents/revalidateRelease.test.ts`. This file does not exist, so it needs its own mocks. `revalidateApprovedIntentForRelease` calls `getToolTier` (`../aiTools`), `checkToolPermission` (`../aiGuardrails`), `getActiveOrgTenant` (`../tenantStatus`), and `buildAuthContextForIntent` (`./actorContext`) — mock all four so the digest checks are reached in isolation. Copy the mocking style from `actorContext.test.ts` in the same directory.

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';

vi.mock('../aiTools', () => ({ getToolTier: vi.fn(() => 3) }));
vi.mock('../aiGuardrails', () => ({ checkToolPermission: vi.fn(() => ({ allowed: true })) }));
vi.mock('../tenantStatus', () => ({ getActiveOrgTenant: vi.fn(async () => ({ status: 'active' })) }));
vi.mock('./actorContext', () => ({
  buildAuthContextForIntent: vi.fn(async () => ({
    scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'],
    user: { id: 'user-1' }, principal: { kind: 'user_session' },
  })),
}));

import { revalidateApprovedIntentForRelease } from './revalidateRelease';

/** Minimal ActionIntent shape the function actually reads. */
function intentFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'intent-1',
    orgId: 'org-1',
    requestedByUserId: 'user-1',
    originPrincipalKind: 'user_session',
    source: 'chat',
    actionName: 'm365_send_mail',
    arguments: {},
    argumentDigest: 'a'.repeat(64),
    riskTier: 3,
    ...overrides,
  } as never;
}

beforeEach(() => vi.clearAllMocks());

describe('revalidateApprovedIntentForRelease digest recompute', () => {
  it('refuses with digest_mismatch when arguments do not hash to argumentDigest', async () => {
    // Simulates a write that bypassed the immutability trigger (superuser,
    // disabled trigger, restore-from-backup). Same error code as the existing
    // stored-string comparison — no new taxonomy.
    const args = { to: ['a@example.com'], subject: 's', bodyText: 'b' };
    const intent = intentFixture({
      arguments: args,
      argumentDigest: 'f'.repeat(64),      // deliberately NOT the real digest
    });
    const result = await revalidateApprovedIntentForRelease(
      intent,
      { boundArgumentDigest: 'f'.repeat(64) },   // approval agrees with the stored digest
    );
    expect(result).toEqual({ ok: false, errorCode: 'digest_mismatch' });
  });

  it('passes the recompute when arguments hash to argumentDigest', async () => {
    const args = { to: ['a@example.com'], subject: 's', bodyText: 'b' };
    const digest = computeArgumentDigest(canonicalizeArguments(args));
    const intent = intentFixture({ arguments: args, argumentDigest: digest });
    const result = await revalidateApprovedIntentForRelease(
      intent,
      { boundArgumentDigest: digest },
    );
    // Later checks (tier, actor) are exercised by this file's other tests;
    // assert only that we did not fail on the digest.
    if (result.ok === false) expect(result.errorCode).not.toBe('digest_mismatch');
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter=@breeze/api exec vitest run src/services/actionIntents/revalidateRelease.test.ts -t 'digest recompute'`
Expected: FAIL — the first test returns `ok: true` (or fails a later check), because nothing recomputes the digest today.

- [ ] **Step 8: Add the recompute to check (a)**

In `revalidateRelease.ts`, add the import:

```ts
import { canonicalizeArguments, computeArgumentDigest } from './canonicalize';
```

Then extend check (a):

```ts
  // (a) The winning approval row must still exist and must have approved the
  // SAME content the intent currently carries.
  if (!winningApproval || winningApproval.boundArgumentDigest !== intent.argumentDigest) {
    return { ok: false, errorCode: 'digest_mismatch' };
  }
  // (a2) Recompute the digest FROM the stored arguments. The comparison above
  // is two stored strings; it cannot detect a write that changed `arguments`
  // while leaving `argument_digest` alone. The immutability trigger makes that
  // unreachable through the app, so this is defense-in-depth against a path
  // that bypassed it (superuser, disabled trigger, restore). Deliberately
  // compares against the STORED digest — the value the approval bound — never
  // a fresh computation used as its own authority (§5.2).
  const recomputed = computeArgumentDigest(
    canonicalizeArguments(intent.arguments as Record<string, unknown>),
  );
  if (recomputed !== intent.argumentDigest) {
    return { ok: false, errorCode: 'digest_mismatch' };
  }
```

- [ ] **Step 9: Run the recompute tests to verify they pass**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/actionIntents/revalidateRelease.test.ts
# Then the two callers whose fixtures the recompute breaks (see blast radius above):
pnpm --filter=@breeze/api exec vitest run src/services/aiAgentSdk.test.ts src/services/aiAgentSdk.planMatch.test.ts
```

Expected: the new file PASSES; the two caller suites FAIL on their `argumentDigest: 'digest-1'` fixtures. Fix each by computing the digest from that fixture's own `arguments`:

```ts
import { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';
const args = { /* whatever the fixture already passes as arguments */ };
// ...
arguments: args,
argumentDigest: computeArgumentDigest(canonicalizeArguments(args)),
```

Do not weaken, skip, or conditionally bypass the recompute to keep a fixture green.

- [ ] **Step 10: Write the integration test proving the trigger still rejects mutation**

Create `apps/api/src/__tests__/integration/actionIntentBinding.integration.test.ts`:

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const connectionId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';

describe('action_intents binding columns', () => {
  runDb('accepts a bound intent and refuses to let either column be mutated', async () => {
    const fx = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const user = await createUser({
        partnerId: partner.id, orgId: org.id,
        email: `binding-${Date.now()}@example.com`,
      });
      return { org, user };
    });

    const [row] = await withSystemDbAccessContext(() => db.insert(actionIntents).values({
      orgId: fx.org.id,
      requestedByUserId: fx.user.id,
      originPrincipalKind: 'user_session',
      source: 'chat',
      actionName: 'm365_send_mail',
      arguments: { to: ['a@example.com'], subject: 's', bodyText: 'b' },
      argumentDigest: 'a'.repeat(64),
      riskTier: 3,
      connectionId,
      tenantId,
      expiresAt: new Date(Date.now() + 3_600_000),
    }).returning({ id: actionIntents.id }));

    // The immutability trigger already covers both columns
    // (2026-07-18-action-intents.sql:109-110) — assert it, do not assume it.
    await expect(withSystemDbAccessContext(() => db.update(actionIntents)
      .set({ connectionId: '33333333-3333-4333-8333-333333333333' })
      .where(eq(actionIntents.id, row!.id))))
      .rejects.toThrow();

    await expect(withSystemDbAccessContext(() => db.update(actionIntents)
      .set({ tenantId: '44444444-4444-4444-8444-444444444444' })
      .where(eq(actionIntents.id, row!.id))))
      .rejects.toThrow();

    const [after] = await withSystemDbAccessContext(() => db.select({
      connectionId: actionIntents.connectionId,
      tenantId: actionIntents.tenantId,
    }).from(actionIntents).where(eq(actionIntents.id, row!.id)));
    expect(after).toEqual({ connectionId, tenantId });
  });
});
```

If the INSERT fails on a NOT NULL column this fixture omits, read `db/schema/actionIntents.ts` and supply it — do not drop the column from the assertion.

- [ ] **Step 11: Run the integration test**

Run: `cd apps/api && DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" npx vitest run --config vitest.integration.config.ts src/__tests__/integration/actionIntentBinding.integration.test.ts`
Expected: PASS (1 test)

- [ ] **Step 12: Run the suites this change can break**

`pnpm --filter=@breeze/api test` does NOT run the separate-config contract suites. Run these explicitly:

```bash
pnpm --filter=@breeze/api exec vitest run src/services/actionIntents src/services/aiAgentSdk
cd apps/api && DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" \
  npx vitest run --config vitest.integration.config.ts \
    src/services/actionIntents/createIntentAtomicity.integration.test.ts \
    src/jobs/intentReleaseWorkerM365Headless.integration.test.ts \
    src/jobs/intentReleaseWorkerGoogleHeadless.integration.test.ts \
    src/__tests__/integration/intentFanout.integration.test.ts \
    src/__tests__/integration/intentSelfApproveGuard.integration.test.ts
```

Expected: PASS. `revalidateRelease` is called by both release paths, so the worker integration suites and the inline `aiAgentSdk` suites are the real blast radius. Note `createIntentAtomicity.integration.test.ts` lives in `src/services/actionIntents/`, not `src/__tests__/integration/` — the integration config includes it via an explicit entry.

- [ ] **Step 13: Typecheck**

Run: `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json`
Expected: no errors. Run from the **repo root** — CI's Type Check resolves the root tsconfig's `noUncheckedIndexedAccess`, which a run from inside `apps/api` does not.

- [ ] **Step 14: Commit**

```bash
git add apps/api/src/services/actionIntents/intentService.ts \
        apps/api/src/services/actionIntents/revalidateRelease.ts \
        apps/api/src/services/actionIntents/intentService.test.ts \
        apps/api/src/services/actionIntents/revalidateRelease.test.ts \
        apps/api/src/__tests__/integration/actionIntentBinding.integration.test.ts
git commit -m "feat(intents): connection binding on create + digest recompute at release

Task 6 of the M365 communications-delegated executor (design §5.2).

CreateActionIntentInput gains an optional binding {connectionId, tenantId},
populating action_intents.connection_id / tenant_id — columns that have shipped
and been trigger-protected since 2026-07-18 but were never written by any
production path. Both are Postgres uuid, so a non-canonical GUID is rejected in
the service rather than surfacing as a 22P02 at INSERT.

revalidateApprovedIntentForRelease now recomputes the digest from the stored
arguments and compares it to the stored argument_digest. The shipped check
compares two stored strings, which cannot detect a write that changed arguments
while leaving the digest alone; the immutability trigger makes that unreachable
through the app, so this is defense-in-depth for a path that bypassed it. It
compares against the STORED digest — the value the approval bound — never a
fresh computation used as its own authority. Reuses digest_mismatch, so audit
and metrics semantics are unchanged."
```

---

### Task 7: Comms runtime config + boot validation

Spec §10. Clone of `writeActionRuntimeConfig.ts` with the allowlist axis swapped from orgs to **users**, and with **no vault vars API-side at all** — the API never touches the comms vault.

**Files:**
- Create: `apps/api/src/services/m365ControlPlane/commsRuntimeConfig.ts`
- Create: `apps/api/src/services/m365ControlPlane/commsRuntimeConfig.test.ts`
- Modify: `apps/api/src/config/validate.ts` — add the import beside line 4, call it beside line 1726

**Interfaces:**
- Consumes: nothing from Task 6.
- Produces, all consumed by Plan 3:
  - `interface M365CommsRuntimeConfig { clientId: string; callbackUrl: string; executorUrl: string; executorAudience: 'm365-communications-executor'; executorSigningPrivateJwk: M365ExecutorSigningPrivateJwk; executorSigningKid: string; tokenCacheStoreConfigured: boolean; onboardingUserIds: '*' | readonly string[]; }`
  - `loadM365CommsRuntimeConfig(source?: Environment): M365CommsRuntimeConfig`
  - `isM365CommsOnboardingEnabledForUser(userId: string, source?: Environment): boolean`
  - `isM365CommsToolsEnabledForUser(userId: string, source?: Environment): boolean` — the hot tool-registration gate (Plan 3 Task 15); must NOT call the full loader
  - `validateM365CommunicationsRuntimeConfigAtBoot(source?: Environment): void`

**Env vars introduced** (§10). All API-side; executor-side vars belong to Plan 2:

| Var | Rule |
|---|---|
| `M365_COMMS_ONBOARDING_ENABLED` | truthy flag |
| `M365_COMMS_ONBOARDING_USER_IDS` | canonical-UUID list or `*`; required when the flag is on |
| `M365_COMMS_TOOLS_ENABLED` | truthy flag |
| `M365_COMMS_TOOLS_USER_IDS` | canonical-UUID list or `*`; required when the flag is on |
| `M365_COMMS_CLIENT_ID` | canonical UUID |
| `M365_COMMS_EXECUTOR_URL` | HTTPS, no userinfo/path/query/fragment |
| `M365_COMMS_EXECUTOR_AUDIENCE` | must equal `m365-communications-executor` |
| `M365_COMMS_EXECUTOR_SIGNING_KID` | non-empty |
| `M365_COMMS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE` | absolute path, `O_NOFOLLOW`, regular file, mode denies group+other, Ed25519 OKP JWK, `kid` matches |

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/m365ControlPlane/commsRuntimeConfig.test.ts`. Read `writeActionRuntimeConfig.test.ts` first and mirror its structure and its JWK-fixture helper (it already writes a temp file with mode 0600); do not invent a second fixture style.

```ts
import { describe, expect, it } from 'vitest';
import {
  loadM365CommsRuntimeConfig,
  isM365CommsOnboardingEnabledForUser,
  isM365CommsToolsEnabledForUser,
  validateM365CommunicationsRuntimeConfigAtBoot,
} from './commsRuntimeConfig';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

// writeJwkFixture(kid, mode?) — reuse the helper from
// writeActionRuntimeConfig.test.ts; it returns an absolute path.
function baseEnv(jwkFile: string) {
  return {
    NODE_ENV: 'test',
    PUBLIC_URL: 'https://app.example.com',
    M365_COMMS_CLIENT_ID: '33333333-3333-4333-8333-333333333333',
    M365_COMMS_EXECUTOR_URL: 'https://comms-executor.internal/',
    M365_COMMS_EXECUTOR_AUDIENCE: 'm365-communications-executor',
    M365_COMMS_EXECUTOR_SIGNING_KID: 'comms-kid-1',
    M365_COMMS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE: jwkFile,
    M365_COMMS_ONBOARDING_ENABLED: 'true',
    M365_COMMS_ONBOARDING_USER_IDS: `${USER_A},${USER_B}`,
  } as Record<string, string>;
}

describe('loadM365CommsRuntimeConfig', () => {
  it('loads a valid config with a USER allowlist', () => {
    const env = baseEnv(writeJwkFixture('comms-kid-1'));
    const cfg = loadM365CommsRuntimeConfig(env);
    expect(cfg.onboardingUserIds).toEqual([USER_A, USER_B]);
    expect(cfg.executorAudience).toBe('m365-communications-executor');
  });

  it('accepts the wildcard allowlist', () => {
    const env = { ...baseEnv(writeJwkFixture('comms-kid-1')), M365_COMMS_ONBOARDING_USER_IDS: '*' };
    expect(loadM365CommsRuntimeConfig(env).onboardingUserIds).toBe('*');
  });

  it('rejects a wrong audience', () => {
    const env = { ...baseEnv(writeJwkFixture('comms-kid-1')), M365_COMMS_EXECUTOR_AUDIENCE: 'm365-graph-actions-executor' };
    expect(() => loadM365CommsRuntimeConfig(env)).toThrow(/must equal m365-communications-executor/);
  });

  it('rejects a non-UUID in the allowlist rather than silently dropping it', () => {
    const env = { ...baseEnv(writeJwkFixture('comms-kid-1')), M365_COMMS_ONBOARDING_USER_IDS: `${USER_A},not-a-uuid` };
    expect(() => loadM365CommsRuntimeConfig(env)).toThrow(/M365_COMMS_ONBOARDING_USER_IDS/);
  });

  it('rejects a JWK file readable by group or other', () => {
    const env = baseEnv(writeJwkFixture('comms-kid-1', 0o644));
    expect(() => loadM365CommsRuntimeConfig(env)).toThrow(/permissions must deny group and other access/);
  });

  it('rejects a JWK whose kid does not match the configured kid', () => {
    const env = baseEnv(writeJwkFixture('some-other-kid'));
    expect(() => loadM365CommsRuntimeConfig(env)).toThrow(/M365_COMMS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE/);
  });

  it('requires no vault vars — the API never touches the comms vault', () => {
    const env = baseEnv(writeJwkFixture('comms-kid-1'));
    expect(() => loadM365CommsRuntimeConfig(env)).not.toThrow();
    expect(Object.keys(env).some((k) => k.includes('VAULT'))).toBe(false);
  });
});

describe('per-user gates', () => {
  it('onboarding gate is false when the flag is off, regardless of allowlist', () => {
    const env = { ...baseEnv(writeJwkFixture('comms-kid-1')), M365_COMMS_ONBOARDING_ENABLED: 'false' };
    expect(isM365CommsOnboardingEnabledForUser(USER_A, env)).toBe(false);
  });

  it('onboarding gate admits an allowlisted user and refuses a non-listed one', () => {
    const env = baseEnv(writeJwkFixture('comms-kid-1'));
    expect(isM365CommsOnboardingEnabledForUser(USER_A, env)).toBe(true);
    expect(isM365CommsOnboardingEnabledForUser('99999999-9999-4999-8999-999999999999', env)).toBe(false);
  });

  it('tools gate does NOT require the executor envs (hot registration path)', () => {
    // Only the flag + the tools allowlist. Calling the full loader here would
    // make every tool registration depend on executor config being present.
    const env = {
      NODE_ENV: 'test',
      M365_COMMS_TOOLS_ENABLED: 'true',
      M365_COMMS_TOOLS_USER_IDS: USER_A,
    } as Record<string, string>;
    expect(isM365CommsToolsEnabledForUser(USER_A, env)).toBe(true);
    expect(isM365CommsToolsEnabledForUser(USER_B, env)).toBe(false);
  });

  it('both gates refuse a malformed user id', () => {
    const env = baseEnv(writeJwkFixture('comms-kid-1'));
    expect(isM365CommsOnboardingEnabledForUser('not-a-uuid', env)).toBe(false);
  });
});

describe('validateM365CommunicationsRuntimeConfigAtBoot', () => {
  it('is a no-op when both flags are off', () => {
    expect(() => validateM365CommunicationsRuntimeConfigAtBoot({ NODE_ENV: 'test' })).not.toThrow();
  });

  it('force-loads when the onboarding flag is on', () => {
    expect(() => validateM365CommunicationsRuntimeConfigAtBoot({
      NODE_ENV: 'test', M365_COMMS_ONBOARDING_ENABLED: 'true',
    })).toThrow(/M365_COMMS_CLIENT_ID is required/);
  });

  it('validates the TOOLS allowlist even though the loader does not read it', () => {
    const env = { ...baseEnv(writeJwkFixture('comms-kid-1')), M365_COMMS_TOOLS_ENABLED: 'true' };
    // M365_COMMS_TOOLS_USER_IDS deliberately absent.
    expect(() => validateM365CommunicationsRuntimeConfigAtBoot(env)).toThrow(/M365_COMMS_TOOLS_USER_IDS/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter=@breeze/api exec vitest run src/services/m365ControlPlane/commsRuntimeConfig.test.ts`
Expected: FAIL — module `./commsRuntimeConfig` does not exist.

- [ ] **Step 3: Implement `commsRuntimeConfig.ts`**

Copy `writeActionRuntimeConfig.ts` as the starting point and make exactly these changes. Do **not** re-derive the JWK/URL parsing from scratch — that code is security-critical and already reviewed.

- Export `EXECUTOR_AUDIENCE = 'm365-communications-executor' as const`.
- Set `CALLBACK_PATH = '/api/v1/m365/comms-consent/callback'`. **This string must byte-match the redirect URI registered in Entra** — the runbook gotcha applies verbatim; a trailing-slash difference fails redemption with a generic error.
- **Delete** `vaultRef`, `credentialVersion`, and all `VAULT_REF` / `CREDENTIAL_VERSION` parsing. The API never touches the comms vault (§10). Keep no vestigial fields.
- Rename the allowlist parsers to `parseCommsOnboardingUserIds` / `parseCommsToolsUserIds`, reading `M365_COMMS_ONBOARDING_USER_IDS` / `M365_COMMS_TOOLS_USER_IDS`. Keep the sibling's behaviour of **throwing** on a malformed entry rather than filtering it out — a silently-dropped id is a silently-denied user.
- `isM365CommsToolsEnabledForUser` must read only the flag + `parseCommsToolsUserIds`, never `loadM365CommsRuntimeConfig`. Copy the sibling's doc comment explaining why (`writeActionRuntimeConfig.ts:245-252`).
- `validateM365CommunicationsRuntimeConfigAtBoot` force-loads when **either** flag is truthy, and additionally calls `parseCommsToolsUserIds` when the tools flag is on — because the loader does not read that allowlist.
- Add `tokenCacheStoreConfigured: false` **only if** a later task needs it API-side. If nothing consumes it, omit it — an unused field in a config type invites a reader to think the API knows about the token cache. It does not.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter=@breeze/api exec vitest run src/services/m365ControlPlane/commsRuntimeConfig.test.ts`
Expected: PASS

- [ ] **Step 5: Wire boot validation**

In `apps/api/src/config/validate.ts`, add beside the existing M365 import (line 4):

```ts
import { validateM365CommunicationsRuntimeConfigAtBoot } from '../services/m365ControlPlane/commsRuntimeConfig';
```

and beside the existing actions call (line 1726):

```ts
  validateM365CommunicationsRuntimeConfigAtBoot(env);
```

Note what is deliberately **not** added: the actions path also asserts `APP_ENCRYPTION_KEY_ID` when its tools flag is on (line 1732), because write-action reveal credentials are sealed with it. Comms has no reveal path and no API-side sealing — the token cache is the executor's, wrapped under a KEK the API's identity cannot `get` (§3.2). Do not copy that assertion.

- [ ] **Step 6: Prove boot validation is wired, not just written**

Add to `apps/api/src/config/validate.test.ts` (or the existing boot-validation suite — read it and match its harness):

```ts
it('fails boot when comms onboarding is enabled without a client id', () => {
  expect(() => validateEnvironment({
    ...minimalValidEnv(),
    M365_COMMS_ONBOARDING_ENABLED: 'true',
  })).toThrow(/M365_COMMS_CLIENT_ID is required/);
});
```

Run: `pnpm --filter=@breeze/api exec vitest run src/config/validate.test.ts -t comms`
Expected: PASS. Without this the wiring in Step 5 is untested — a call site can be deleted and every `commsRuntimeConfig.test.ts` test still passes.

- [ ] **Step 7: Add `.env.example` entries**

There is **no** `apps/api/.env.example`. The M365 vars live in the repo-root `.env.example` (the actions block starts at line ~155). Append the comms block there, immediately after it. Generic placeholders only — never a real client id or hostname.

```bash
# M365 communications-delegated (per-USER axis; dark by default)
M365_COMMS_ONBOARDING_ENABLED=false
M365_COMMS_ONBOARDING_USER_IDS=
M365_COMMS_TOOLS_ENABLED=false
M365_COMMS_TOOLS_USER_IDS=
M365_COMMS_CLIENT_ID=
M365_COMMS_EXECUTOR_URL=https://comms-executor.internal/
M365_COMMS_EXECUTOR_AUDIENCE=m365-communications-executor
M365_COMMS_EXECUTOR_SIGNING_KID=
M365_COMMS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE=/run/secrets/m365_comms_executor_signing_private_jwk
```

- [ ] **Step 7b: Map every one of those vars into `docker-compose.yml` — `.env.example` alone is a silent no-op**

**This step is not optional and its omission is a CI failure, not a deploy-time surprise.** `apps/api/src/config/envComposeParity.test.ts` (required **Test API** job) asserts that every var documented in the root `.env.example` actually reaches a container. Compose interpolation only happens for vars listed in a service's `environment:` block — a value in `.env` that is not mapped there never reaches the process, so the var reads as unset at runtime and boot validation silently passes.

Add to the `api` service `environment:` block in `docker-compose.yml`, after the `M365_GRAPH_ACTIONS_*` entries:

```yaml
      # M365 communications-delegated. Gated per USER, not per org — a delegated
      # mailbox connection is owned by one human. No vault vars here on purpose:
      # the API never touches the comms vault (the client certificate and the
      # token-cache KEK belong to the executor, which is the only identity that
      # can decrypt the cache).
      M365_COMMS_ONBOARDING_ENABLED: ${M365_COMMS_ONBOARDING_ENABLED:-false}
      M365_COMMS_ONBOARDING_USER_IDS: ${M365_COMMS_ONBOARDING_USER_IDS:-}
      M365_COMMS_TOOLS_ENABLED: ${M365_COMMS_TOOLS_ENABLED:-false}
      M365_COMMS_TOOLS_USER_IDS: ${M365_COMMS_TOOLS_USER_IDS:-}
      M365_COMMS_CLIENT_ID: ${M365_COMMS_CLIENT_ID:-}
      M365_COMMS_EXECUTOR_URL: ${M365_COMMS_EXECUTOR_URL:-}
      M365_COMMS_EXECUTOR_AUDIENCE: ${M365_COMMS_EXECUTOR_AUDIENCE:-m365-communications-executor}
      M365_COMMS_EXECUTOR_SIGNING_KID: ${M365_COMMS_EXECUTOR_SIGNING_KID:-}
      M365_COMMS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE: /run/secrets/m365_comms_executor_signing_private_jwk
```

The JWK path is a Docker **secret**, not a bind mount, so it also needs both halves of the secret wiring the siblings use — the `api` service's `secrets:` list:

```yaml
      - source: m365_comms_executor_signing_private_jwk
        target: m365_comms_executor_signing_private_jwk
```

and the top-level `secrets:` block, defaulting to `/dev/null` so dark deployments stay optional:

```yaml
  m365_comms_executor_signing_private_jwk:
    file: ${M365_COMMS_EXECUTOR_SIGNING_PRIVATE_JWK_SOURCE_FILE:-/dev/null}
```

- [ ] **Step 8: Run both compose guards**

```bash
pnpm --filter=@breeze/api exec vitest run src/config/envComposeParity.test.ts src/config/composeBindMounts.test.ts
```

Expected: PASS. `envComposeParity` is the one Step 7b satisfies. `composeBindMounts` asserts that a file-shaped, repo-relative bind-mount source exists — this plan adds no bind mounts (the JWK is a secret with a `/dev/null` default, not a mount), so it should be unaffected.

> If `composeBindMounts` fails to load with `TypeError: defineScalarTag is not a function`, that is a local `yaml` dependency resolution problem, not your change — confirm by stashing and re-running. CI resolves it correctly.

- [ ] **Step 9: Typecheck and lint**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
pnpm --filter=@breeze/api exec eslint src/services/m365ControlPlane/commsRuntimeConfig.ts src/config/validate.ts
```
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/commsRuntimeConfig.ts \
        apps/api/src/services/m365ControlPlane/commsRuntimeConfig.test.ts \
        apps/api/src/config/validate.ts \
        apps/api/src/config/validate.test.ts \
        .env.example
git commit -m "feat(m365): comms runtime config + boot validation (per-user axis)

Task 7 of the M365 communications-delegated executor (design §10).

Cloned from writeActionRuntimeConfig.ts with two deliberate divergences:

- The allowlist axis is USERS, not orgs. v1 ships with one UUID, but nothing
  hardcodes a single user — the design is N-user from day one.
- No vault vars API-side at all. The API never touches the comms vault: the
  client certificate and the token-cache KEK are the executor's, and the KEK is
  one the API's identity cannot get. APP_ENCRYPTION_KEY_ID is deliberately NOT
  asserted here (the actions path needs it for reveal sealing; comms has no
  reveal path).

isM365CommsToolsEnabledForUser reads only the flag and the tools allowlist,
never the full loader, because it sits on the hot tool-registration path.
Boot validation therefore checks that allowlist explicitly — the loader does
not read it, so a malformed value would otherwise fail at every tool call
instead of at boot.

The call site in config/validate.ts has its own test: without one, the wiring
can be deleted while every unit test still passes."
```

---

## Self-Review

**1. Spec coverage.** This plan covers §14 tasks 6 and 7 in full: §5.2 sender pinning and the release recompute (Task 6); §10 enablement, allowlists, and boot validation (Task 7). Everything else in §14 is either shipped (0–5, tabled above) or assigned to Plan 2 (8–11) / Plan 3 (12–18). No §14 item in the 6–7 range is unassigned.

Deliberately **not** in this plan, with reasons: the token-cache DSN from §10's executor column belongs to Plan 2, since the API never configures that store; `MAX_REPLICAS` is not carried forward at all (§10 removes it).

**2. Placeholder scan.** No TBD/TODO. Every code step carries the actual content.

Every referenced path was verified to exist before this plan was committed, and four claims were wrong on the first draft and are now corrected:

| First draft said | Actually |
|---|---|
| `revalidateRelease.test.ts` exists, reuse its `intentFixture()` | **No such file.** Step 6 creates it, with its own four mocks and fixture |
| `apps/api/.env.example` | Only the repo-root `.env.example` carries M365 vars |
| `createIntentAtomicity.integration.test.ts` under `src/__tests__/integration/` | Lives in `src/services/actionIntents/` |
| (nothing about caller fixtures) | `aiAgentSdk.test.ts:241` and `aiAgentSdk.planMatch.test.ts:118` use `argumentDigest: 'digest-1'` and **will** fail the recompute — now called out as known blast radius with the fix |

Two places still instruct the implementer to reuse an existing helper rather than reproducing it (`captureInsertValues` in `intentService.test.ts`, `writeJwkFixture` in `writeActionRuntimeConfig.test.ts`). That is deliberate: those files exist and already have a mocking style, and introducing a second style in a shipped test file is a real defect. Both steps say to read the file and match it if the name differs.

**3. Type consistency.** `binding?: { connectionId: string; tenantId: string }` is the name used in Task 6's type, its tests, and its Produces block. `revalidateApprovedIntentForRelease` keeps its shipped signature — both release-path callers are shipped and unmodified. `M365CommsRuntimeConfig` field names match between the Produces block, the tests, and the implementation notes. `EXECUTOR_AUDIENCE` is `'m365-communications-executor'` in all three places. `isM365CommsToolsEnabledForUser` (not `...ForOrg`) is used consistently, matching the user axis.

---

## Execution Handoff

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Plans 2 and 3 are not yet written. Plan 2 (the executor service: scaffold + CI, fenced CAS token cache, MSAL client, operations) is the largest and has no dependency on this plan — it can be written and executed in parallel.
