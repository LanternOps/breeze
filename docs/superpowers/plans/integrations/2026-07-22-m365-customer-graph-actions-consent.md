# M365 Customer Graph Actions — Consent & Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the shipped `customer-graph-actions` M365 mutation path a real onboarding layer — admin consent, PKCE identity verification, exact grant reconciliation, connection lifecycle, and a management UI — so it can be enabled for a real customer tenant.

**Architecture:** Hybrid reuse of the shipped `customer-graph-read` consent flow. Parameterize the risky shared internals by profile (consent-session service; a `createConnectionService` factory; profile-tagged metrics), add the missing consent/reconcile endpoints to the actions executor, and stack a thin per-profile route + UI card on top. Ships dark behind a new per-org onboarding allowlist. Folds in two enablement-gating security items (inline seal parity; a boot key-id assertion).

**Tech Stack:** Hono (API), Drizzle ORM + Postgres (RLS), Vitest (unit/integration), Node executor sidecar (`apps/m365-graph-actions-executor/`), Astro/React (web), hand-written SQL migrations.

## Global Constraints

- **Credential-domain separation is locked.** Actions has its own Azure app registration (`M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID`), cert/AKV secret (`m365-customer-graph-actions`), and executor (port 3004, audience `m365-graph-actions-executor`). Never reuse the read app/cert/executor for actions.
- **Least privilege:** consent + reconciliation enforce exactly two scopes — `User.ReadWrite.All` (`204e0828-b5ca-4ad8-b9f3-f32a958e7cc4`) and `User-PasswordProfile.ReadWrite.All` (`56760768-b641-451f-8906-e1b8ab31bca7`), resource = Microsoft Graph `00000003-0000-0000-c000-000000000000`.
- **Migrations:** hand-written SQL in `apps/api/migrations/`, `YYYY-MM-DD-<slug>.sql`, idempotent (`IF EXISTS`/`DO $$`/`pg_*` existence checks), no inner `BEGIN;`/`COMMIT;`, never edit a shipped migration. Same-day dependent ordering uses `-a-`/`-b-` infix.
- **RLS:** every read/write goes through a DB access context (`withDbAccessContext` request path, `withSystemDbAccessContext` for consent/system paths); bare pool is forbidden. Reuses `m365_connections` (dual-axis RLS, already allows the actions profile) and `m365_consent_sessions`.
- **Web mutations** must go through `runAction`. **i18n** keys must have parity across all 5 locales (`en`, `de-DE`, `fr-FR`, `es-419`, `pt-BR`) — CI-enforced.
- **Dark by default:** new onboarding gate `M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED=false` + `_ONBOARDING_ORG_IDS` allowlist, boot-validated. The separate `M365_GRAPH_ACTIONS_TOOLS_ENABLED` execution gate is unchanged.
- **Tests needing a real DB** run against Postgres on `:5433` via `vitest.integration.config.ts`. Unit tests mock Drizzle.
- **Never commit** real tenant ids, secrets, or infra hostnames. Runbooks use placeholders.

**Baseline:** branch `ToddHebebrand/m365-customer-graph-actions-consent` off `main` (`f1b3f63ca`). Spec: `docs/superpowers/specs/integrations/2026-07-22-breeze-m365-customer-graph-actions-consent-design.md`.

---

## Task Ordering & Dependencies

1. Profile manifest (shared) → 2. Consent-session CHECK migration → 3. Parameterize consent-session service → 4. Actions runtime config (onboarding) → 5. Boot validation → 6. `createConnectionService` factory (read stays green) → 7. `writeActionConnectionService` → 8. Actions executor consent endpoints → 9. Actions executor client methods → 10. Actions consent route → 11. Actions consent callback instance → 12. Integration tests → 13. Seal-parity security fix → 14. UI card + i18n → 15. Deploy plumbing + runbook.

Tasks 1–5 are independent-ish leaves; 6–11 are the spine; 12 proves it; 13–15 finish. Commit after every task.

---

### Task 1: Profile manifest — least-privilege scopes + app-role assignments

**Files:**
- Modify: `packages/shared/src/m365/profiles.ts` (the `'customer-graph-actions'` block, ~line 145)
- Test: `packages/shared/src/m365/profiles.test.ts`

**Interfaces:**
- Produces: `M365_PERMISSION_PROFILES['customer-graph-actions'].applicationPermissions` = the 2 in-use scopes; `.applicationPermissionAssignments` = 2 `M365ApplicationGrant` entries. Consumed by Tasks 7, 8, 12 (reconciliation) and the UI card (Task 14).

- [ ] **Step 1: Write the failing test** — append to `profiles.test.ts`:

```ts
import { M365_PERMISSION_PROFILES, canonicalGrantKey } from './profiles';

describe('customer-graph-actions manifest (least privilege)', () => {
  const p = M365_PERMISSION_PROFILES['customer-graph-actions'];

  it('requests exactly the two in-use application scopes', () => {
    expect([...p.applicationPermissions].sort()).toEqual(
      ['User-PasswordProfile.ReadWrite.All', 'User.ReadWrite.All'],
    );
  });

  it('declares the matching app-role assignments with verified Graph GUIDs', () => {
    const byValue = Object.fromEntries(
      (p.applicationPermissionAssignments ?? []).map((g) => [g.value, g]),
    );
    expect(byValue['User.ReadWrite.All']?.appRoleId).toBe('204e0828-b5ca-4ad8-b9f3-f32a958e7cc4');
    expect(byValue['User-PasswordProfile.ReadWrite.All']?.appRoleId).toBe('56760768-b641-451f-8906-e1b8ab31bca7');
    for (const g of p.applicationPermissionAssignments ?? []) {
      expect(g.resourceApplicationId).toBe('00000003-0000-0000-c000-000000000000');
    }
  });

  it('assignment set equals the requested scope set', () => {
    const assignmentValues = (p.applicationPermissionAssignments ?? []).map((g) => g.value).sort();
    expect(assignmentValues).toEqual([...p.applicationPermissions].sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/shared test -- profiles.test.ts`
Expected: FAIL (actions block has 6 scopes, no `applicationPermissionAssignments`).

- [ ] **Step 3: Edit the manifest.** In `profiles.ts`, replace the `'customer-graph-actions'` block's `applicationPermissions` + add assignments:

```ts
  'customer-graph-actions': {
    id: 'customer-graph-actions',
    version: 1,
    ownerAxis: 'organization',
    authMode: 'application-certificate',
    credentialDomain: 'customer-graph-actions',
    executor: 'graph-actions',
    delegatedPermissions: [],
    applicationPermissions: [
      'User.ReadWrite.All',
      'User-PasswordProfile.ReadWrite.All',
      // roadmap (each future action needs a manifest version bump + customer re-consent):
      //   'Group.ReadWrite.All',
      //   'DeviceManagementManagedDevices.PrivilegedOperations.All',
      //   'DeviceManagementConfiguration.ReadWrite.All',
      //   'Sites.ReadWrite.All',
    ],
    applicationPermissionAssignments: [
      {
        resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
        appRoleId: '204e0828-b5ca-4ad8-b9f3-f32a958e7cc4',
        value: 'User.ReadWrite.All',
      },
      {
        resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
        appRoleId: '56760768-b641-451f-8906-e1b8ab31bca7',
        value: 'User-PasswordProfile.ReadWrite.All',
      },
    ],
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/shared test -- profiles.test.ts`
Expected: PASS. Also run `pnpm --filter @breeze/shared typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/m365/profiles.ts packages/shared/src/m365/profiles.test.ts
git commit -m "feat(m365): least-privilege actions profile with verified app-role GUIDs"
```

---

### Task 2: Widen the `m365_consent_sessions.profile` CHECK for actions

**Files:**
- Create: `apps/api/migrations/2026-07-22-m365-consent-sessions-actions-profile.sql`
- Modify: `apps/api/src/db/schema/m365.ts` (the `profile` column `$type` on `m365ConsentSessions`, ~line 96)
- Test: `apps/api/src/db/autoMigrate.test.ts` runs automatically; add a targeted assertion if a suitable place exists, otherwise rely on drift check.

**Interfaces:**
- Produces: `m365_consent_sessions` rows may carry `profile='customer-graph-actions'`. Consumed by Task 3 (session service inserts) and Task 12.

- [ ] **Step 1: Write the migration** (idempotent CHECK swap):

```sql
-- Widen m365_consent_sessions.profile to admit the customer-graph-actions profile.
-- The read-consent migration pinned this to a single value; onboarding a second
-- profile reuses the same table.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'm365_consent_sessions_profile_check'
      AND conrelid = 'm365_consent_sessions'::regclass
  ) THEN
    ALTER TABLE m365_consent_sessions DROP CONSTRAINT m365_consent_sessions_profile_check;
  END IF;
END $$;

ALTER TABLE m365_consent_sessions
  ADD CONSTRAINT m365_consent_sessions_profile_check
  CHECK (profile IN ('customer-graph-read', 'customer-graph-actions'));
```

Note: re-running drops-then-adds the same constraint — a true no-op. No inner `BEGIN;`/`COMMIT;` (autoMigrate wraps the file).

- [ ] **Step 2: Update the Drizzle schema type.** In `apps/api/src/db/schema/m365.ts`, change the consent-sessions `profile` column type from `.$type<'customer-graph-read'>()` to:

```ts
    profile: text('profile').notNull().$type<'customer-graph-read' | 'customer-graph-actions'>(),
```

(Keep the existing `.default(...)` / column name exactly as-is; only the `$type` union widens.)

- [ ] **Step 3: Apply + verify no drift**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm --filter @breeze/api exec tsx src/db/runMigrations.ts   # or the repo's migrate entrypoint
pnpm db:check-drift
```
Expected: migration applies; drift check reports no diff. Also run `pnpm --filter @breeze/api test -- autoMigrate.test.ts` (ordering regression) — Expected: PASS.

- [ ] **Step 4: Verify the CHECK as `breeze_app`**

Run: `docker exec -i breeze-postgres psql -U breeze_app -d breeze -c "\d+ m365_consent_sessions" | grep -i profile_check`
Expected: shows `CHECK (profile = ANY (ARRAY['customer-graph-read'::text, 'customer-graph-actions'::text]))`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-07-22-m365-consent-sessions-actions-profile.sql apps/api/src/db/schema/m365.ts
git commit -m "feat(db): admit customer-graph-actions in m365_consent_sessions profile check"
```

---

### Task 3: Parameterize `consentSessionService` by profile

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/consentSessionService.ts`
- Modify: all read call sites that build the session inputs (found via grep in Step 3)
- Test: `apps/api/src/services/m365ControlPlane/consentSessionService.test.ts`

**Interfaces:**
- Consumes: `M365ConnectionProfile` from `@breeze/shared/m365`.
- Produces: `ConsentSessionOwnerInput`, `ConsentSessionAttemptInput` now carry `profile: M365ConnectionProfile`; every insert/consume/delete uses `input.profile` instead of the `CUSTOMER_GRAPH_READ_PROFILE` constant. Consumed by Tasks 6/7 (factory passes profile) and Task 11.

- [ ] **Step 1: Write the failing test** — add to `consentSessionService.test.ts` a case that an actions-profile session round-trips and is isolated from read:

```ts
it('scopes admin-consent sessions by profile', async () => {
  const base = { connectionId: cid, orgId, consentAttemptId: aid, userId: uid };
  const { rawState } = await createAdminConsentSession({ ...base, profile: 'customer-graph-actions' });

  // wrong-profile consume must miss
  expect(await consumeConsentSession({
    connectionId: cid, orgId, consentAttemptId: aid, rawState, phase: 'admin_consent',
    profile: 'customer-graph-read',
  })).toBeNull();

  // correct-profile consume hits
  const hit = await consumeConsentSession({
    connectionId: cid, orgId, consentAttemptId: aid, rawState, phase: 'admin_consent',
    profile: 'customer-graph-actions',
  });
  expect(hit?.profile).toBe('customer-graph-actions');
});
```

(Match the file's existing fixture/setup style for `cid/orgId/aid/uid` and its DB harness.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test -- consentSessionService.test.ts`
Expected: FAIL (type error / `profile` unknown, and consume ignores profile).

- [ ] **Step 3: Parameterize the service.** In `consentSessionService.ts`:
  - Delete `const CUSTOMER_GRAPH_READ_PROFILE = 'customer-graph-read' as const;` (line 12).
  - Add `import type { M365ConnectionProfile } from '@breeze/shared/m365';` (match existing shared import path in the file/package).
  - Add `profile: M365ConnectionProfile;` to `ConsentSessionOwnerInput` (line 17) and `ConsentSessionAttemptInput` (line 24). `ConsumeConsentSessionInput` extends the attempt input, so it inherits it.
  - In `insertConsentSessionInTransaction` (line 71) replace `profile: CUSTOMER_GRAPH_READ_PROFILE,` with `profile: input.profile,`.
  - In `insertPreparedIdentityVerificationSessionInTransaction` (line 146) replace `profile: CUSTOMER_GRAPH_READ_PROFILE,` with `profile: input.profile,`.
  - In `consumeConsentSessionInTransaction` (line 185) replace `eq(m365ConsentSessions.profile, CUSTOMER_GRAPH_READ_PROFILE)` with `eq(m365ConsentSessions.profile, input.profile)`.
  - In `deleteConsentSessionsForAttemptInTransaction` (line 201) replace with `eq(m365ConsentSessions.profile, input.profile)`.
  - Ensure `prepareIdentityVerificationSession` / `insertPrepared...` still receive `profile` (thread it via the owner input passed to `insertPreparedIdentityVerificationSessionInTransaction`).

- [ ] **Step 4: Fix read call sites.** Run `grep -rn "createAdminConsentSession\|createIdentityVerificationSession\|consumeConsentSession\|deleteConsentSessionsForAttempt\|createAdminConsentSessionInTransaction\|createIdentityVerificationSessionInTransaction\|insertPreparedIdentityVerificationSessionInTransaction" apps/api/src --include=*.ts | grep -v test`. For every non-test caller (all in `connectionService.ts` / `m365ConsentCallback.ts` today), add `profile: 'customer-graph-read'` to the input object. (These become factory-driven in Task 6 — for now hardcode read to keep the suite green.)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @breeze/api test -- consentSessionService.test.ts && pnpm --filter @breeze/api typecheck`
Expected: PASS. Then run the read consent route + connection service suites to confirm no regression: `pnpm --filter @breeze/api test -- m365 connectionService`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/consentSessionService.ts apps/api/src/services/m365ControlPlane/consentSessionService.test.ts apps/api/src/services/m365ControlPlane/connectionService.ts apps/api/src/routes/m365ConsentCallback.ts
git commit -m "refactor(m365): parameterize consent-session service by profile"
```

---

### Task 4: Actions onboarding runtime config + env gate

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/writeActionRuntimeConfig.ts`
- Modify: `apps/api/src/config/env.ts`
- Test: `apps/api/src/services/m365ControlPlane/writeActionRuntimeConfig.test.ts`, `apps/api/src/config/env.test.ts`

**Interfaces:**
- Produces:
  - `env.ts`: `m365CustomerGraphActionsOnboardingEnabled(): boolean`.
  - `writeActionRuntimeConfig.ts`: config gains `callbackUrl: string` and `onboardingOrgIds: '*' | readonly string[]`; new `isM365CustomerGraphActionsOnboardingEnabledForOrg(orgId: string, source?: Environment): boolean`; boot validator extended. Consumed by Tasks 5, 7, 10, 11.
- New env vars: `M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED`, `M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ORG_IDS`.

- [ ] **Step 1: Write failing tests.** In `env.test.ts`, add `M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED` to the `OAUTH_ENV_KEYS` cleanup array, then:

```ts
it('defaults M365 customer Graph-actions onboarding to false', async () => {
  const mod = await loadEnv();
  expect(mod.m365CustomerGraphActionsOnboardingEnabled()).toBe(false);
});
it('reads M365 customer Graph-actions onboarding at call time', async () => {
  const mod = await loadEnv();
  process.env.M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED = 'true';
  expect(mod.m365CustomerGraphActionsOnboardingEnabled()).toBe(true);
  process.env.M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED = 'false';
  expect(mod.m365CustomerGraphActionsOnboardingEnabled()).toBe(false);
});
```

In `writeActionRuntimeConfig.test.ts`, mirror `runtimeConfig.test.ts`'s onboarding-org-id + gate cases for the actions keys (allowlist parse, `*`, invalid-uuid throw, required-when-enabled throw, `isM365CustomerGraphActionsOnboardingEnabledForOrg` true/false).

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @breeze/api test -- writeActionRuntimeConfig.test.ts env.test.ts`
Expected: FAIL (functions/fields undefined).

- [ ] **Step 3: Implement.** In `env.ts`, after `m365CustomerGraphReadOnboardingEnabled` (line ~38):

```ts
export function m365CustomerGraphActionsOnboardingEnabled(): boolean {
  return envFlag('M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED', false);
}
```

In `writeActionRuntimeConfig.ts`, mirror `runtimeConfig.ts`'s onboarding machinery (its `parseOnboardingOrgIds` at lines 158–173, `callbackUrl` parse at 49–70, `isM365CustomerGraphReadOnboardingEnabledForOrg` at 234–242, boot validator at 260–277):
  - Add `callbackUrl` to `M365CustomerGraphActionsRuntimeConfig` and a `parseCallbackUrl` sourcing `PUBLIC_URL`/`PUBLIC_APP_URL`/`PUBLIC_API_URL` with a fixed actions callback path `/api/v1/m365/actions-consent/callback`.
  - Add `onboardingOrgIds` + `parseActionsOnboardingOrgIds(source)` reading `M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ORG_IDS` / `_ONBOARDING_ENABLED` (identical shape to read; reuse the `CANONICAL_UUID` regex and `flagEnabled` local).
  - Export `isM365CustomerGraphActionsOnboardingEnabledForOrg(orgId, source = process.env)`.
  - Extend `validateM365CustomerGraphActionsRuntimeConfigAtBoot` to also trigger when `flagEnabled(source.M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED)` (the `||` pattern read uses), so an onboarding-enabled deploy fails boot without a complete descriptor.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @breeze/api test -- writeActionRuntimeConfig.test.ts env.test.ts && pnpm --filter @breeze/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/writeActionRuntimeConfig.ts apps/api/src/config/env.ts apps/api/src/services/m365ControlPlane/writeActionRuntimeConfig.test.ts apps/api/src/config/env.test.ts
git commit -m "feat(m365): actions onboarding runtime config + per-org gate"
```

---

### Task 5: Boot validation — actions descriptor + `APP_ENCRYPTION_KEY_ID` when tools enabled

**Files:**
- Modify: `apps/api/src/config/validate.ts` (~line 1536, after `validateM365CustomerGraphActionsRuntimeConfigAtBoot(env)`)
- Test: `apps/api/src/config/validate.test.ts`

**Interfaces:**
- Consumes: `validateM365CustomerGraphActionsRuntimeConfigAtBoot` (Task 4, now onboarding-aware).
- Produces: boot throws when `M365_GRAPH_ACTIONS_TOOLS_ENABLED=true` and `APP_ENCRYPTION_KEY_ID` is empty; boot throws when actions onboarding enabled without a complete descriptor.

- [ ] **Step 1: Write failing tests.** In `validate.test.ts`, add a `describe('M365 customer Graph-actions onboarding + reveal key', ...)` mirroring the read block:

```ts
it('refuses boot when actions onboarding is enabled without a complete descriptor', () => {
  withEnv({ ...validEnv,
    M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED: 'true',
    M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID: '' }, () => {
    expect(() => validateConfig()).toThrow(/M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID/);
  });
});
it('requires APP_ENCRYPTION_KEY_ID when write-action tools are enabled', () => {
  withEnv({ ...validEnv,
    M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'true',
    APP_ENCRYPTION_KEY_ID: '' }, () => {
    expect(() => validateConfig()).toThrow(/APP_ENCRYPTION_KEY_ID/);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @breeze/api test -- validate.test.ts`
Expected: FAIL (no key-id rule; onboarding descriptor not validated — the second may already pass via Task 4's boot validator, that's fine).

- [ ] **Step 3: Implement.** In `validate.ts`, immediately after the `validateM365CustomerGraphActionsRuntimeConfigAtBoot(env);` call and before `_config = result.data;`:

```ts
  // APP_ENCRYPTION_KEY_ID is required once Graph write-action tools are enabled:
  // the reset-password reveal seals its temp credential with AAD-bound v3 ciphertext
  // and fails closed at runtime if the key id is absent. Turn that into a boot error.
  const truthy = (raw?: string) => ['true', '1', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());
  if (truthy(env.M365_GRAPH_ACTIONS_TOOLS_ENABLED) && !env.APP_ENCRYPTION_KEY_ID?.trim()) {
    throw new Error(
      'APP_ENCRYPTION_KEY_ID is required when M365_GRAPH_ACTIONS_TOOLS_ENABLED=true (write-action reveal credentials are sealed with AAD-bound v3 ciphertext).',
    );
  }
```

(If a `truthyFlag`/`envFlag` helper is already in scope at that point, reuse it instead of the local.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @breeze/api test -- validate.test.ts && pnpm --filter @breeze/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config/validate.ts apps/api/src/config/validate.test.ts
git commit -m "feat(config): boot requires APP_ENCRYPTION_KEY_ID when actions tools enabled"
```

---

### Task 6: Extract `createConnectionService` factory (read stays green)

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/connectionService.ts` → extract factory; keep read exports as a thin instantiation.
- Modify: `apps/api/src/services/m365ControlPlane/metrics.ts` → allow a profile-tagged event/metric recorder (or add an actions surface).
- Test: existing `connectionService.test.ts` must stay green; add a factory-level test.

**Interfaces:**
- Consumes: `consentSessionService` (profile param, Task 3), `deriveGrantHealth` (already manifest-param), `M365PermissionProfileManifest`.
- Produces: `createConnectionService(deps: ConnectionServiceDeps): ConnectionService` where

```ts
interface ConnectionServiceDeps {
  profile: M365ConnectionProfile;
  manifest: M365PermissionProfileManifest;
  loadRuntimeConfig: () => { clientId: string; callbackUrl: string; /* executor + vault fields */ };
  createExecutorClient: (cfg: ReturnType<ConnectionServiceDeps['loadRuntimeConfig']>) => M365ConsentExecutorClient;
  recordEvent: (name: string, fields: Record<string, unknown>) => void;
  recordMetric: (outcome: string) => void;
}
interface ConnectionService {
  initiateConsent(input: { orgId: string; actorId: string }): Promise<{ connection: M365ConnectionSnapshot; rawState: string; consentUrl: string }>;
  markAdminConsentReturned(input: ConsentAttemptSnapshot): Promise<M365ConnectionSnapshot>;
  transitionAdminConsentToIdentity(input: { attempt: ConsentAttemptSnapshot; rawAdminState: string; prepared: PreparedIdentityVerificationSession }): Promise<{ connection: M365ConnectionSnapshot; identity: { rawState: string; codeChallenge: string }; actorId: string }>;
  markConsentAttemptFailed(input: ConsentAttemptSnapshot, errorCode: string): Promise<M365ConnectionSnapshot>;
  applyIdentityVerificationResult(input: ConsentAttemptSnapshot, result: CompleteConsentResult): Promise<M365ConnectionSnapshot>;
  retestConnection(input: { id: string; orgId: string; auth: AuthContext; correlationId?: string; executorClient?: M365ConsentExecutorClient }): Promise<M365ConnectionSnapshot>;
  disconnectConnection(input: { id: string; orgId: string; actorId: string }): Promise<M365ConnectionSnapshot>;
  listConnections(orgId: string): Promise<Array<M365ConnectionSnapshot & { grantHealth: GrantHealth }>>;
}
```
  `M365ConsentExecutorClient` is the shared shape both executor clients satisfy for consent: `{ completeIdentityVerification(req: CompleteConsentRequest): Promise<CompleteConsentResult>; retest(req: RetestRequest): Promise<RetestResult> }`. Consumed by Task 7 (actions instance) and Task 10/11.

- [ ] **Step 1: Characterization first — confirm read suite is green before refactor.**

Run: `pnpm --filter @breeze/api test -- connectionService.test.ts`
Expected: PASS (this is the safety net for the refactor).

- [ ] **Step 2: Extract the factory.** Move the body of `connectionService.ts` into `createConnectionService(deps)`, replacing every hardcoded reference the review found with a `deps` field:
  - `PROFILE` (line 30) → `deps.profile`.
  - `M365_PERMISSION_PROFILES[PROFILE]` (226, 253) → `deps.manifest`.
  - `loadM365CustomerGraphReadRuntimeConfig()` (272, 454, 616) → `deps.loadRuntimeConfig()`; the clientId anti-spoof check at 454 uses `deps.loadRuntimeConfig().clientId`.
  - `runtimeClient(...)` / `createGraphReadExecutorClient` (233–240) → `deps.createExecutorClient`.
  - metrics/event calls → `deps.recordEvent` / `deps.recordMetric`.
  - Every `createAdminConsentSession(...)`/`createIdentityVerificationSession(...)` call now passes `profile: deps.profile`.
  Rename the exported functions to the generic `ConnectionService` names above.

- [ ] **Step 3: Re-instantiate read as thin wrapper.** At the bottom of `connectionService.ts` (or a small `readConnectionService.ts`), export the read instance and keep the old public names as aliases so existing importers/tests don't break:

```ts
const readConnectionService = createConnectionService({
  profile: 'customer-graph-read',
  manifest: M365_PERMISSION_PROFILES['customer-graph-read'],
  loadRuntimeConfig: loadM365CustomerGraphReadRuntimeConfig,
  createExecutorClient: (cfg) => createGraphReadExecutorClient(cfg),
  recordEvent: recordM365CustomerGraphReadEvent,
  recordMetric: recordM365CustomerGraphReadMetric,
});
export const initiateCustomerGraphReadConsent = readConnectionService.initiateConsent;
export const listCustomerGraphReadConnections = readConnectionService.listConnections;
export const retestCustomerGraphReadConnection = readConnectionService.retestConnection;
export const disconnectCustomerGraphReadConnection = readConnectionService.disconnectConnection;
// ...and the callback-facing exports (markAdminConsentReturned, transitionAdminConsentToIdentity,
//    markConsentAttemptFailed, applyIdentityVerificationResult) preserved by name.
```

- [ ] **Step 4: Metrics.** In `metrics.ts`, generalize the recorder so it accepts a profile-scoped event name (e.g. `recordM365ConsentEvent(profile, name, fields)`), or add `recordM365CustomerGraphActionsEvent/Metric` siblings. Keep the read function names as thin wrappers so read behavior is byte-identical.

- [ ] **Step 5: Run the read suite (must still be green) + factory test**

Run: `pnpm --filter @breeze/api test -- connectionService.test.ts metrics.test.ts && pnpm --filter @breeze/api typecheck`
Expected: PASS — proves the refactor preserved read behavior (spec acceptance #3).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/connectionService.ts apps/api/src/services/m365ControlPlane/metrics.ts apps/api/src/services/m365ControlPlane/*.test.ts
git commit -m "refactor(m365): extract createConnectionService factory (read unchanged)"
```

---

### Task 7: `writeActionConnectionService` — actions instantiation

**Files:**
- Create: `apps/api/src/services/m365ControlPlane/writeActionConnectionService.ts`
- Test: `apps/api/src/services/m365ControlPlane/writeActionConnectionService.test.ts`

**Interfaces:**
- Consumes: `createConnectionService` (Task 6), actions manifest (Task 1), `loadM365CustomerGraphActionsRuntimeConfig` + `createGraphActionsExecutorClient` (Task 9 adds the consent methods), actions metrics (Task 6).
- Produces: `actionsConnectionService: ConnectionService` and the named exports the actions route/callback consume: `initiateCustomerGraphActionsConsent`, `listCustomerGraphActionsConnections`, `retestCustomerGraphActionsConnection`, `disconnectCustomerGraphActionsConnection`, plus callback-facing `markAdminConsentReturned`/`transitionAdminConsentToIdentity`/`markConsentAttemptFailed`/`applyIdentityVerificationResult` bound to the actions instance.

- [ ] **Step 1: Write failing test** — assert the actions instance initiates consent against the actions client id and rejects a read-profile connection id:

```ts
it('initiates actions consent with the actions app client id + callback', async () => {
  // arrange: onboarding-enabled env for one org, actions runtime config stubbed
  const { consentUrl, connection } = await initiateCustomerGraphActionsConsent({ orgId, actorId });
  expect(connection.profile).toBe('customer-graph-actions');
  expect(consentUrl).toContain(`client_id=${ACTIONS_CLIENT_ID}`);
  expect(consentUrl).toContain('/api/v1/m365/actions-consent/callback');
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @breeze/api test -- writeActionConnectionService.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** the thin instantiation:

```ts
import { M365_PERMISSION_PROFILES } from '@breeze/shared/m365';
import { createConnectionService } from './connectionService';
import { loadM365CustomerGraphActionsRuntimeConfig } from './writeActionRuntimeConfig';
import { createGraphActionsExecutorClient } from './graphActionsExecutorClient';
import { recordM365CustomerGraphActionsEvent, recordM365CustomerGraphActionsMetric } from './metrics';

const actionsConnectionService = createConnectionService({
  profile: 'customer-graph-actions',
  manifest: M365_PERMISSION_PROFILES['customer-graph-actions'],
  loadRuntimeConfig: loadM365CustomerGraphActionsRuntimeConfig,
  createExecutorClient: (cfg) => createGraphActionsExecutorClient(cfg),
  recordEvent: recordM365CustomerGraphActionsEvent,
  recordMetric: recordM365CustomerGraphActionsMetric,
});

export const initiateCustomerGraphActionsConsent = actionsConnectionService.initiateConsent;
export const listCustomerGraphActionsConnections = actionsConnectionService.listConnections;
export const retestCustomerGraphActionsConnection = actionsConnectionService.retestConnection;
export const disconnectCustomerGraphActionsConnection = actionsConnectionService.disconnectConnection;
export { actionsConnectionService };
```

(The executor client's consent methods land in Task 9; if Task 9 isn't done yet, the type will require them — implement Task 9 first or stub the client shape. Recommended order: do Task 9 before this task's Step 3, or accept a temporary `as` cast the test flags.)

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @breeze/api test -- writeActionConnectionService.test.ts && pnpm --filter @breeze/api typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/writeActionConnectionService.ts apps/api/src/services/m365ControlPlane/writeActionConnectionService.test.ts
git commit -m "feat(m365): actions connection service instance"
```

---

### Task 8: Actions executor — `complete-consent` + `retest` endpoints

**Files:**
- Create: `apps/m365-graph-actions-executor/src/microsoft/reconcile.ts` (re-key of the read executor's `reconcile.ts`)
- Modify: the actions executor router (mirror the read executor's endpoint registration for `complete-consent` + `retest`)
- Test: `apps/m365-graph-actions-executor/src/microsoft/reconcile.test.ts` + a handler test

**Interfaces:**
- Consumes: the actions certificate/token client already in the actions executor; the shared `CompleteConsentRequest/Result`, `RetestRequest/Result` types.
- Produces: `POST /v1/complete-consent` and `POST /v1/retest` on the actions executor, reconciling granted app-roles against the 2-entry actions manifest, authenticated by the actions Ed25519/EdDSA internal-auth (same as `execute-action`). Consumed by Task 9.

- [ ] **Step 1: Study the read executor.** Read `apps/m365-graph-read-executor/src/microsoft/reconcile.ts` and its `complete-consent`/`retest` handlers + route registration. Note the internal-auth middleware, the bounded-Graph client, and how `reconcile.ts` diffs `appRoleAssignments` against the manifest.

- [ ] **Step 2: Write failing reconcile test** in the actions executor, mirroring the read `reconcile.test.ts`: given a Graph `appRoleAssignedTo`/`appRoleAssignments` response containing exactly the two actions app-role ids, `reconcile()` returns `observedGrants` = the two values, `missing` = [], `unexpected` = []; given a third role, it lands in `unexpected`; given only one, the other is `missing`.

- [ ] **Step 3: Run to verify fail** — `pnpm --filter @breeze/m365-graph-actions-executor test -- reconcile.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement `reconcile.ts`** as a re-key of the read executor's (identical diff logic; the manifest/assignments are passed in, so the code is profile-agnostic — copy it verbatim and adjust only imports/paths). Then register `POST /v1/complete-consent` and `POST /v1/retest` handlers that: authenticate via the actions internal-auth, acquire an app token with the actions certificate for the target tenant, call Graph for the SP's `appRoleAssignments`, run `reconcile()` against the actions manifest, and return the `CompleteConsentResult`/`RetestResult` shape the read executor returns.

- [ ] **Step 5: Run tests** — `pnpm --filter @breeze/m365-graph-actions-executor test` and build: `pnpm --filter @breeze/m365-graph-actions-executor build` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/m365-graph-actions-executor/src/
git commit -m "feat(m365-actions-executor): complete-consent + retest reconciliation endpoints"
```

---

### Task 9: `graphActionsExecutorClient` — consent methods

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/graphActionsExecutorClient.ts`
- Test: `apps/api/src/services/m365ControlPlane/graphActionsExecutorClient.test.ts`

**Interfaces:**
- Consumes: Task 8's executor endpoints; shared `CompleteConsentRequest/Result`, `RetestRequest/Result`.
- Produces: `GraphActionsExecutorClient` additionally exposes `completeIdentityVerification(input: CompleteConsentRequest): Promise<CompleteConsentResult>` and `retest(input: RetestRequest): Promise<RetestResult>`; the endpoint map gains `complete-consent` + `retest`. Satisfies the `M365ConsentExecutorClient` shape (Task 6). Consumed by Task 7.

- [ ] **Step 1: Write failing test** mirroring `graphReadExecutorClient.test.ts`'s complete-consent/retest cases (assert the client POSTs to the actions audience + `/v1/complete-consent` with an EdDSA body-hash header, returns the parsed result).

- [ ] **Step 2: Run to verify fail** — FAIL (methods undefined).

- [ ] **Step 3: Implement.** Add the two methods + endpoint-map entries to the actions client, mirroring the read client's implementations byte-for-byte except the audience literal (`m365-graph-actions-executor`) and endpoint paths. Import the shared request/result types (already used by the read client).

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @breeze/api test -- graphActionsExecutorClient.test.ts && pnpm --filter @breeze/api typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/graphActionsExecutorClient.ts apps/api/src/services/m365ControlPlane/graphActionsExecutorClient.test.ts
git commit -m "feat(m365): actions executor client consent methods"
```

---

### Task 10: Actions consent route + mount

**Files:**
- Create: `apps/api/src/routes/m365CustomerGraphActions.ts`
- Modify: `apps/api/src/index.ts` (mount, near the read route at ~966)
- Test: `apps/api/src/routes/m365CustomerGraphActions.test.ts`

**Interfaces:**
- Consumes: `writeActionConnectionService` exports (Task 7), `isM365CustomerGraphActionsOnboardingEnabledForOrg` (Task 4).
- Produces: Hono routes `GET /connections` envelope (includes `onboardingEnabled` for actions), `POST /connections/customer-graph-actions/consent`, `POST /connections/:id/retest`, `POST /connections/:id/disconnect`; exported `m365CustomerGraphActionsRoutes`. Consumed by the UI card (Task 14).

- [ ] **Step 1: Write failing route tests** mirroring `m365CustomerGraphRead.test.ts`: onboarding-disabled org → consent returns the dark/unavailable response (matches read's shape); enabled+allowlisted org → consent returns `adminConsentUrl`; retest/disconnect authz (`requireOrgsWrite` + `requireMfa()`). Use the same test harness/mocks as the read route test.

- [ ] **Step 2: Run to verify fail** — FAIL (route missing).

- [ ] **Step 3: Implement** `m365CustomerGraphActions.ts` as a mirror of `m365CustomerGraphRead.ts` with: `PROFILE_ID = 'customer-graph-actions'`, `profileManifest = M365_PERMISSION_PROFILES['customer-graph-actions']`, the actions gate function, the actions connection-service exports, and the actions display name. Route paths use the `customer-graph-actions` segment. Envelope returns `onboardingEnabled` from the actions gate. Export `m365CustomerGraphActionsRoutes`.

- [ ] **Step 4: Mount** in `index.ts` right after the read route mount:

```ts
api.route('/m365', m365CustomerGraphActionsRoutes);
```

(Confirm mount order: the public callback routes — Task 11 — mount before authenticated M365 routes, matching the existing read comment at index.ts:965.)

- [ ] **Step 5: Run to verify pass** — `pnpm --filter @breeze/api test -- m365CustomerGraphActions.test.ts && pnpm --filter @breeze/api typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/m365CustomerGraphActions.ts apps/api/src/index.ts apps/api/src/routes/m365CustomerGraphActions.test.ts
git commit -m "feat(m365): actions consent route (dark, allowlisted)"
```

---

### Task 11: Actions consent callback instance + mount

**Files:**
- Modify: `apps/api/src/routes/m365ConsentCallback.ts` (parameterize the factory `createM365ConsentCallbackRoutes(overrides)` by profile + config + executor client + redirect base; instantiate an actions instance)
- Modify: `apps/api/src/index.ts` (mount the actions callback on `/api/v1/m365/actions-consent/callback`'s base)
- Test: `apps/api/src/routes/m365ConsentCallback.test.ts` (add actions-profile cases)

**Interfaces:**
- Consumes: `writeActionConnectionService` callback-facing exports (Task 7), actions runtime config + executor client, `consumeConsentSession` with `profile: 'customer-graph-actions'`.
- Produces: `m365ActionsConsentCallbackRoutes` handling the actions two-phase callback; redirect target `/integrations#m365/customer-graph-actions/<outcome>`.

- [ ] **Step 1: Write failing test** — an actions admin-consent-return + identity-verification callback drives the actions connection to `active` and redirects to the actions fragment; a read-profile binding is not accepted by the actions instance and vice-versa.

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Parameterize the callback factory.** In `m365ConsentCallback.ts`, thread a `profile` (default `'customer-graph-read'`), a config loader, an executor-client factory, and a redirect-base into `createM365ConsentCallbackRoutes(overrides)`, replacing the hardcoded read references the review found (lines 32, 155, 159, 163, 170–178, 235, 249, 325). `loadAttemptFromBinding`'s `eq(m365Connections.profile, ...)` and guard use the injected profile; `completeIdentityWithRuntime` uses the injected config loader + executor factory; `consumeConsentSession` passes the injected profile. Keep the exported default read instance byte-compatible.

- [ ] **Step 4: Instantiate + mount actions callback.**

```ts
export const m365ActionsConsentCallbackRoutes = createM365ConsentCallbackRoutes({
  profile: 'customer-graph-actions',
  loadRuntimeConfig: loadM365CustomerGraphActionsRuntimeConfig,
  createExecutorClient: (cfg) => createGraphActionsExecutorClient(cfg),
  redirectBase: '/integrations#m365/customer-graph-actions',
  connectionService: actionsConnectionService,
});
```

Mount in `index.ts` before the authenticated actions route, on the actions callback path base (matching `parseCallbackUrl`'s `/api/v1/m365/actions-consent/callback` from Task 4).

- [ ] **Step 5: Run to verify pass** — `pnpm --filter @breeze/api test -- m365ConsentCallback.test.ts && pnpm --filter @breeze/api typecheck` → PASS. Re-run the read callback cases to confirm no regression.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/m365ConsentCallback.ts apps/api/src/index.ts apps/api/src/routes/m365ConsentCallback.test.ts
git commit -m "feat(m365): actions consent callback instance + mount"
```

---

### Task 12: Integration tests against real Postgres

**Files:**
- Create: `apps/api/src/__tests__/integration/m365CustomerGraphActionsConsent.integration.test.ts`
- Reference existing: `m365ConnectionLifecycle.integration.test.ts` for harness setup.

**Interfaces:**
- Consumes: the full stack from Tasks 1–11 with a stubbed actions executor client (inject a fake `M365ConsentExecutorClient` returning canned reconciliation results).

- [ ] **Step 1: Write the integration suite** (real PG :5433) covering spec acceptance criteria:
  - **Happy path:** initiate → admin-consent-return → identity verification with a fake executor returning exactly the 2 grants → connection `active`, `observedGrants` = the 2, `missing`/`unexpected` empty.
  - **Missing grant:** executor returns only 1 → connection blocked from `active`, `missing` = the other; health reflects it.
  - **Extra grant (drift):** executor returns a third role → `unexpected` non-empty, not `active`.
  - **Cross-org fail-closed:** an actions consent session for org A cannot be consumed/advanced under org B.
  - **Cross-profile fail-closed:** a `customer-graph-read` connection row cannot satisfy an actions reconciliation, and an actions consent session cannot be consumed with `profile: 'customer-graph-read'`.
  - **Dark-flag off:** with actions onboarding disabled / org not allowlisted, the consent route returns the unavailable response and no session/connection row is created.

- [ ] **Step 2: Run**

Run: `pnpm --filter @breeze/api test:integration -- m365CustomerGraphActionsConsent`
Expected: PASS (needs Postgres on :5433 — start via the repo's integration DB compose).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/m365CustomerGraphActionsConsent.integration.test.ts
git commit -m "test(m365): real-PG actions consent lifecycle + fail-closed coverage"
```

---

### Task 13: Seal-parity security fix (inline result path)

**Files:**
- Modify: `apps/api/src/services/actionIntents/resultSecrets.ts` and/or the inline dispatch result-write site so both dispatch paths seal the reset-password temp credential identically.
- Test: co-located unit test asserting both paths persist a sealed (v3, AAD-bound) credential and never plaintext.

**Interfaces:**
- Consumes: the existing `resultSecrets.ts` seal helper shipped with the reveal work (#2693).
- Produces: the inline result path stores `temporaryPasswordEnc` sealed exactly like the headless worker path; no code path persists the plaintext reset password at rest.

> Implementation detail and the pre-fix window are intentionally out of this public plan — keep specifics in the internal notes. The observable contract to test: after an inline reset-password execution, the stored intent result exposes only the sealed credential shape, and the reveal endpoint accepts it.

- [ ] **Step 1: Write the failing test** — drive the inline result-write with a known temp password; assert the persisted result carries a v3-sealed `temporaryPasswordEnc` (AAD-bound) and no plaintext field; assert the reveal endpoint decrypts it once.

- [ ] **Step 2: Run to verify fail** — FAIL (inline path stores unsealed today).

- [ ] **Step 3: Implement** — route the inline result write through the same `resultSecrets.ts` seal used by the worker, dropping the credential fail-closed if the key id is unset (mirror the worker's v3-only guard).

- [ ] **Step 4: Run to verify pass** — PASS; run the reveal endpoint + reaper tests to confirm no regression.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/actionIntents/ apps/api/src/routes/actionIntents.ts
git commit -m "fix(security): seal reset-password temp credential on the inline path too"
```

---

### Task 14: Management UI card + i18n + mount

**Files:**
- Create: `apps/web/src/components/integrations/M365CustomerGraphActionsCard.tsx`
- Modify: `apps/web/src/components/integrations/IntegrationsPage.tsx` (render near the read card, ~line 439, inside the `identity`/`m365` subtab `space-y-6` wrapper)
- Create i18n keys in: `apps/web/src/locales/{en,de-DE,fr-FR,es-419,pt-BR}/integrations.json` (namespace `m365CustomerGraphActions`)
- Test: `apps/web/src/components/integrations/M365CustomerGraphActionsCard.test.tsx`

**Interfaces:**
- Consumes: the actions route endpoints (Task 10) — `GET /m365/connections?orgId=` returns the actions envelope with `onboardingEnabled`; `POST /m365/connections/customer-graph-actions/consent`, `/:id/retest`, `/:id/disconnect`.
- Produces: a server-gated card (renders always, but `onboardingEnabled` from the envelope disables Connect + shows unavailable copy — same pattern as read, no client allowlist).

- [ ] **Step 1: Write failing test** — mirror `M365CustomerGraphReadCard.test.tsx`: renders title, disables Connect when `onboardingEnabled=false`, wraps mutations in `runAction` (assert error toast on `{success:false}`), shows the 2-scope grant health (`observedGrants`/`missingGrants`/`unexpectedGrants`).

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @breeze/web test -- M365CustomerGraphActionsCard` → FAIL.

- [ ] **Step 3: Implement the card** by mirroring `M365CustomerGraphReadCard.tsx` with the `m365CustomerGraphActions` i18n namespace and the actions consent endpoint path. The status enum and grant-health three-column model are identical; the required-grant list is the 2 actions scopes; drop read-only error codes that don't apply (per spec §9). Preserve the `scopedRequest`/`OrgGeneration` org-switch-race guard from the read card. All mutations via `runAction`.

- [ ] **Step 4: Add i18n keys** to all 5 locale `integrations.json` files under `m365CustomerGraphActions` — mirror the read key set (title, description, status.*, grants.*, actions.*, errors.* minus the inapplicable ones). Provide real translations for each locale (mirror the read card's existing translations' tone; do not leave English placeholders in non-en files — key parity + literal-key gates are CI-enforced).

- [ ] **Step 5: Mount** in `IntegrationsPage.tsx` beside the read card:

```tsx
<M365CustomerGraphActionsCard callbackResult={...} callbackRefreshKey={...} />
```

- [ ] **Step 6: Run to verify pass** — `pnpm --filter @breeze/web test -- M365CustomerGraphActionsCard && pnpm --filter @breeze/web typecheck && pnpm --filter @breeze/web test -- i18n` (key parity) → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/integrations/M365CustomerGraphActionsCard.tsx apps/web/src/components/integrations/IntegrationsPage.tsx apps/web/src/components/integrations/M365CustomerGraphActionsCard.test.tsx apps/web/src/locales/*/integrations.json
git commit -m "feat(web): customer-graph-actions onboarding card + i18n"
```

---

### Task 15: Deploy plumbing — compose service block + real-tenant runbook

**Files:**
- Modify: `docker-compose.yml` (+ `deploy/docker-compose.prod.yml` if it defines executor services) — add the `m365-graph-actions-executor` service block (mirror any read-executor block; if none exists, add both are out of scope — add only actions per this plan and note the read gap).
- Modify: `docs/deploy/m365-customer-graph-actions-executor.md` (already exists) — fill/confirm the compose block, port, AKV secret, and the `APP_ENCRYPTION_KEY_ID`/`APP_ENCRYPTION_KEY` droplet-mapping requirement + the two new onboarding env vars.
- Create: `docs/runbooks/m365-customer-graph-actions-real-tenant.md`

**Interfaces:** none (docs + compose).

- [ ] **Step 1: Compose service block.** Add an `m365-graph-actions-executor` service: private-bind, `M365_GRAPH_ACTIONS_EXECUTOR_PORT`/bind host, AKV secret `m365-customer-graph-actions`, signing public JWK/kid, audience `m365-graph-actions-executor`, issuer. Mirror the actions executor Dockerfile/build already in `apps/m365-graph-actions-executor/`. Do NOT add the Watchtower label (hardening check forbids it on breeze-api/web; keep it off sidecars per policy). Run `bash scripts/check-supply-chain-hardening.sh` (or the repo's path) → Expected: PASS.

- [ ] **Step 2: Deploy runbook.** In `docs/deploy/m365-customer-graph-actions-executor.md`, ensure the Runtime configuration section lists the API env (`M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED`, `_ONBOARDING_ORG_IDS`, `_CLIENT_ID`, `_CREDENTIAL_VERSION`, `_VAULT_REF`, `M365_GRAPH_ACTIONS_EXECUTOR_*`, `M365_GRAPH_ACTIONS_TOOLS_ENABLED`, `_TOOLS_ORG_IDS`) and executor env, and adds an explicit callout: `APP_ENCRYPTION_KEY_ID` + `APP_ENCRYPTION_KEY` must be in `/opt/breeze/.env` AND the api service `environment:` block on EU+US before `M365_GRAPH_ACTIONS_TOOLS_ENABLED=true` (else reveal fails closed; boot now refuses per Task 5).

- [ ] **Step 3: Real-tenant runbook.** Create `docs/runbooks/m365-customer-graph-actions-real-tenant.md` — a narrow acceptance (one allowlisted org, real tenant): consent screen capture, confirm reconciliation shows exactly the 2 grants, drive an approved `m365_reset_password` intent through headless execution, confirm the one-time reveal, secret non-observation review. Use placeholders for tenant ids (no real identifiers).

- [ ] **Step 4: Verify docs build / links** (if the repo lints docs) and re-run the hardening check.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml deploy/docker-compose.prod.yml docs/deploy/m365-customer-graph-actions-executor.md docs/runbooks/m365-customer-graph-actions-real-tenant.md
git commit -m "chore(deploy): actions executor compose block + real-tenant runbook"
```

---

## Final Verification

- [ ] Full API unit suite: `pnpm --filter @breeze/api test` → PASS.
- [ ] API integration (real PG :5433): `pnpm --filter @breeze/api test:integration -- m365` → PASS.
- [ ] Executor: `pnpm --filter @breeze/m365-graph-actions-executor test && build` → PASS.
- [ ] Web: `pnpm --filter @breeze/web test && typecheck` + i18n parity → PASS.
- [ ] `pnpm db:check-drift` → no drift.
- [ ] Typecheck across workspaces → clean.
- [ ] Confirm read consent flow suites still green (regression guard for the factory + callback + session refactors — spec acceptance #3).
- [ ] Manual: with all flags off, actions onboarding endpoints return the unavailable response and the card shows disabled — feature ships dark.

## Spec Coverage Map

- Spec §7 (manifest + CHECK migration) → Tasks 1, 2
- Spec §8 (parameterize session/factory/callback/executor endpoints/metrics) → Tasks 3, 6, 8, 9, 11
- Spec §9 (exact reconciliation) → Tasks 8, 12
- Spec §10 (config + boot validation) → Tasks 4, 5
- Spec §11 (security follow-ups) → Tasks 5 (key-id), 13 (seal parity)
- Spec §12 (management UI) → Task 14
- Spec §13 (audit/metrics) → Task 6
- Spec §14 (failure/concurrency) → Task 12
- Spec §15 (verification) → Tasks 12, 15
- Spec §16 (deploy/rollout) → Task 15
- Spec §17 (acceptance) → Final Verification + Task 12
