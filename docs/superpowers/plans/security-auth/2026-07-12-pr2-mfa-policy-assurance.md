# PR 2 — MFA Policy & Assurance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MFA *policy* (role `force_mfa` + org/partner `security.requireMfa`/`allowedMethods`, resolved through partner inheritance) and MFA *assurance* (epoch- and status-bound pending records, factor-change global sign-out, working recovery codes, existing-factor step-up) durable and consistent. Close SR2-05, SR2-06, SR2-07, SR2-09, SR2-19, SR2-20, SR2-24.

**Architecture:** Introduce one effective-MFA-policy resolver (`services/mfaPolicy.ts`) consumed by middleware, login, enrollment and factor operations — strictest-wins across role force + effective settings, passkey always allowed. The vacuous `mfa=true` for unenrolled-but-policy-required users is removed (forced-enrollment response instead). Pending MFA records gain `authEpoch/mfaEpoch/statusExpectation/allowedMethods/expiresAt`; every completion path reloads the live user + policy, compares, and consumes atomically before minting. TOTP setup confirmation switches to the consuming verifier. A new `services/mfaAssurance.ts` helper wraps every mutating factor handler in one transaction that advances `mfa_epoch` + revokes all refresh families (via PR 1's `authLifecycle` primitives), then post-commit runs Redis/OAuth cleanup + remote-session teardown — a deliberate global sign-out on any factor change. Recovery-code login is built from scratch (schema relax + atomic single-hash removal). Adding a factor to an already-protected account requires a short-lived single-use step-up grant proving an existing factor.

**Tech Stack:** Hono (TypeScript), Drizzle ORM, PostgreSQL (RLS via `breeze_app`), Redis (ioredis), `otplib` TOTP, `@simplewebauthn/server`, Vitest.

**Stacks on:** `core-auth-1-lifecycle-foundation` (PR #2378). All PR 1 primitives are already merged into this branch: `advanceUserEpochs`, `revokeAllRefreshFamilies`, `revokeRefreshFamilyById`, `runPostCommitCleanup`, `Tx` (`services/authLifecycle.ts`); `getUserEpochs` (`services/authEpochs.ts`, re-exported from `services/index.ts`); epoch columns on `users`; `aep/mep/sid` JWT claims. Do not re-implement them.

## Global Constraints

- **Node 22.20.0.** Prefix every `pnpm`/`node` command with `export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"` (no version manager is installed; the pinned binary lives there).
- **No migration in PR 2.** The epoch columns (`users.auth_epoch`, `users.mfa_epoch`, …) ship in PR 1; `users.mfa_recovery_codes` (jsonb) already exists. **This PR adds no tables and no columns → no `rls-coverage.integration.test.ts` allowlist changes.** If a task appears to need a new column, STOP — it does not; re-read this constraint.
- **Epoch enforcement is scoped to `aud=breeze-api` user tokens only** (unchanged from PR 1). Factor operations bump **`mfa_epoch`** only (never `auth_epoch`).
- **Audit events never contain raw MFA codes, recovery codes, TOTP secrets, WebAuthn assertions, or tokens.** Recovery-code audit records a count/index or `null`, never the code or its hash.
- **Public auth errors are generic; server-side audit reasons are specific.** A pending-MFA epoch mismatch returns the same `Invalid or expired MFA session` body that an expired token returns; the audit event carries the precise reason.
- **Security-state DB failure fails the mutation** (no success audit). Redis/cache cleanup failure = bounded telemetry, never restores token validity. Single-use consumption (recovery code, step-up grant, pending record) fails closed on Redis/DB ambiguity.
- **DB context.** Self-service factor handlers run inside the authenticated request context (user-scoped RLS). Writes to the user's OWN `users` row and OWN `refresh_token_families` pass Shape-6 / user-id-scoped policies, so an ambient `db.transaction` is correct there (same reasoning PR 1 used for `/change-password`). Code that reads cross-tenant rows pre-context or from another user (the policy resolver's role/settings joins) must establish system context; use `runOutsideDbContext(() => withSystemDbAccessContext(...))` so it is correct whether or not a request context is already active.
- **Commit after each green task.** TDD: write the failing test, observe the reviewed failure, then implement.

## File Structure

- **Create** `apps/api/src/services/mfaPolicy.ts` + `mfaPolicy.test.ts` — effective-policy resolver (Task 1).
- **Create** `apps/api/src/services/mfaAssurance.ts` + `mfaAssurance.test.ts` — factor-change invalidation helper (Task 7).
- **Create** `apps/api/src/services/mfaStepUpGrant.ts` + `mfaStepUpGrant.test.ts` — existing-factor step-up grant (Task 8).
- **Modify** `apps/api/src/middleware/auth.ts` — enrollment gate uses the resolver (Task 3).
- **Modify** `apps/api/src/routes/auth/login.ts` — forced-enrollment response + epoch/status/method-bound pending record (Tasks 3, 4).
- **Modify** `apps/api/src/routes/auth/mfa.ts` — pending-MFA validation, recovery branch, consuming setup verifier, factor-change invalidation (Tasks 4, 5, 6, 7).
- **Modify** `apps/api/src/routes/auth/passkeys.ts` — pending-MFA validation, factor-change invalidation, step-up grant on register (Tasks 4, 7, 8).
- **Modify** `apps/api/src/routes/auth/phone.ts` — allowedMethods reader via resolver, factor-change invalidation on SMS enable + phone replacement (Tasks 2, 7).
- **Modify** `apps/api/src/routes/auth/schemas.ts` — `mfaVerifySchema` recovery method (Task 6).
- **Modify** `apps/api/src/routes/auth/helpers.ts` — `PendingMfaRecord` type + parser/evaluator (Task 4).
- **Modify** `apps/api/src/routes/orgs.ts` — `allowedMfaMethods` input alias normalization (Task 2).
- **Modify** `apps/api/src/services/index.ts` — re-export `getEffectiveMfaPolicy` for the mock boundary (Task 1).
- **Create** `apps/api/src/__tests__/integration/mfaAssurance.integration.test.ts`, `recoveryCode.integration.test.ts`, `pendingMfaEpoch.integration.test.ts` (Task 9).

---

### Task 1: MFA policy resolver service

**Files:**
- Create: `apps/api/src/services/mfaPolicy.ts`
- Create: `apps/api/src/services/mfaPolicy.test.ts`
- Modify: `apps/api/src/services/index.ts` (barrel export)

**Interfaces:**
- Consumes: `roles.forceMfa` via `organization_users`/`partner_users` join (same shape as `middleware/auth.ts` `userRoleRequiresMfa`); `mfaForcePartnerAdmin()` (`config/env.ts`, env `MFA_FORCE_FOR_PARTNER_ADMIN`, default true); `getEffectiveOrgSettings(orgId)` (`services/effectiveSettings.ts` — returns `{ effective, locked }`, partner-inherited); `partners.settings` (partner-scope path); `runOutsideDbContext`/`withSystemDbAccessContext` (`db/index.ts`).
- Produces:
  ```ts
  export interface MfaPolicyInput {
    scope: 'system' | 'partner' | 'organization';
    userId: string;
    orgId: string | null;
    partnerId: string | null;
  }
  export interface MfaAllowedMethods { totp: boolean; sms: boolean; passkey: boolean }
  export interface EffectiveMfaPolicy {
    required: boolean;
    allowedMethods: MfaAllowedMethods;   // passkey ALWAYS true
    source: { roleForceMfa: boolean; settingsRequireMfa: boolean; killSwitchOff: boolean };
  }
  export async function getEffectiveMfaPolicy(input: MfaPolicyInput): Promise<EffectiveMfaPolicy>;
  ```

**Design decisions (documented inline in the file's header comment):**
- **Strictest-wins.** `required = roleForceMfa OR settingsRequireMfa`. A method is `allowed` unless the effective settings explicitly disable it. `passkey` is always allowed — it is phishing-resistant, so an org/partner cannot forbid the strongest factor (only totp/sms can be restricted).
- **Kill switch gates ONLY the role-force component.** `MFA_FORCE_FOR_PARTNER_ADMIN` is named and documented for the partner-admin *role* force (roles schema comment: "Seeded true for the privileged partner-admin slug"). When `mfaForcePartnerAdmin()` is false, role-driven forcing is suppressed (`roleForceApplies = roleForceMfa && !killSwitchOff`), but org/partner `security.requireMfa` is STILL enforced — so `required = roleForceApplies || settingsRequireMfa`. Overloading this env flag into a global MFA-disable that silently drops org/partner-configured compliance would be a latent foot-gun in a hardening PR, so it is deliberately narrowed. `source.killSwitchOff` is retained (useful for audit) but now means "role-force suppressed", not "everything suppressed". `allowedMethods` is unaffected by the kill switch. (Overseer decision, overriding the earlier "global escape hatch" choice.)
- **Scope resolution.**
  - `system` → `required=false`, all methods allowed, no joins (platform admin is governed by `is_platform_admin`, not tenant MFA policy — there is no tenant axis to resolve).
  - `organization` (has `orgId`) → role join on `organization_users`; settings from `getEffectiveOrgSettings(orgId).effective.security` (partner defaults already merged in).
  - `partner` (has `partnerId`, no `orgId`) → role join on `partner_users`; settings from the partner's own `partners.settings.security` (no org to inherit through).
- **Fail-open on settings read errors.** `getEffectiveOrgSettings` throws `HTTPException(404)` for a missing org/partner. Reading effective settings is wrapped in try/catch: on error, `settingsRequireMfa=false` and totp/sms stay allowed (role force still applies). Rationale: a transient settings-read blip must not mass-lock a tenant out of login, and it must not silently reject a factor that was allowed at enrollment. This is a deliberate availability-over-strictness choice for policy resolution only (single-use consumption still fails closed — Tasks 4/6/8).
- **Runs under system context from every caller.** The role join and settings reads touch cross-tenant tables before the request RLS context is set (middleware/login) or from within a user-scoped context (factor completion). `runOutsideDbContext(() => withSystemDbAccessContext(...))` is correct in both cases.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/mfaPolicy.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const roleRows: { forceMfa: boolean }[] = [];
let effectiveSecurity: Record<string, unknown> | undefined;
let effectiveThrows = false;

vi.mock('../db', () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(roleRows),
    then: (r: (v: unknown[]) => unknown) => r(roleRows),
  };
  return {
    db: { select: () => chain },
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
  };
});

vi.mock('./effectiveSettings', () => ({
  getEffectiveOrgSettings: vi.fn(async () => {
    if (effectiveThrows) throw new Error('boom');
    return { effective: { security: effectiveSecurity ?? {} }, locked: [] };
  }),
}));

// Declare BEFORE the mock factory. The arrow defers the `killSwitch` read to
// call time, so per-test reassignment is seen (avoids the vitest-hoist TDZ
// footgun where a factory reading a not-yet-initialized let would throw).
let killSwitch = true;
vi.mock('../config/env', () => ({ mfaForcePartnerAdmin: () => killSwitch }));

import { getEffectiveMfaPolicy } from './mfaPolicy';

beforeEach(() => {
  roleRows.length = 0;
  effectiveSecurity = undefined;
  effectiveThrows = false;
  killSwitch = true;
});

describe('getEffectiveMfaPolicy', () => {
  it('system scope: never required, all methods allowed, no joins', async () => {
    const p = await getEffectiveMfaPolicy({ scope: 'system', userId: 'u1', orgId: null, partnerId: null });
    expect(p.required).toBe(false);
    expect(p.allowedMethods).toEqual({ totp: true, sms: true, passkey: true });
  });

  it('org role force_mfa=true forces required', async () => {
    roleRows.push({ forceMfa: true });
    const p = await getEffectiveMfaPolicy({ scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null });
    expect(p.required).toBe(true);
    expect(p.source.roleForceMfa).toBe(true);
  });

  it('org settings requireMfa=true forces required even when role does not', async () => {
    roleRows.push({ forceMfa: false });
    effectiveSecurity = { requireMfa: true };
    const p = await getEffectiveMfaPolicy({ scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null });
    expect(p.required).toBe(true);
    expect(p.source.settingsRequireMfa).toBe(true);
  });

  it('allowedMethods.sms=false disables sms; passkey stays allowed', async () => {
    roleRows.push({ forceMfa: false });
    effectiveSecurity = { allowedMethods: { totp: true, sms: false } };
    const p = await getEffectiveMfaPolicy({ scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null });
    expect(p.allowedMethods).toEqual({ totp: true, sms: false, passkey: true });
  });

  it('kill switch off suppresses role-force: role force_mfa=true + no settings requireMfa => not required', async () => {
    killSwitch = false;
    roleRows.push({ forceMfa: true });
    effectiveSecurity = undefined; // no settings requireMfa
    const p = await getEffectiveMfaPolicy({ scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null });
    expect(p.required).toBe(false);
    expect(p.source.killSwitchOff).toBe(true);
  });

  it('kill switch off does NOT suppress settings: settings requireMfa=true (role false) => still required', async () => {
    killSwitch = false;
    roleRows.push({ forceMfa: false });
    effectiveSecurity = { requireMfa: true };
    const p = await getEffectiveMfaPolicy({ scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null });
    expect(p.required).toBe(true);
    expect(p.source.settingsRequireMfa).toBe(true);
  });

  it('fails open on settings read error: not required, methods allowed', async () => {
    roleRows.push({ forceMfa: false });
    effectiveThrows = true;
    const p = await getEffectiveMfaPolicy({ scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null });
    expect(p.required).toBe(false);
    expect(p.allowedMethods).toEqual({ totp: true, sms: true, passkey: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/mfaPolicy.test.ts
```
Expected: FAIL — cannot find module `./mfaPolicy`.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/mfaPolicy.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { roles, organizationUsers, partnerUsers } from '../db/schema/users';
import { partners } from '../db/schema/orgs';
import { getEffectiveOrgSettings } from './effectiveSettings';
import { mfaForcePartnerAdmin } from '../config/env';
import { captureException } from './sentry';

/**
 * Single source of truth for "does this user need MFA, and which factors may
 * they use". Combines role `force_mfa` (via the same membership join the
 * middleware enrollment gate used to make directly) with org/partner
 * `security.requireMfa`/`security.allowedMethods` resolved THROUGH
 * getEffectiveOrgSettings so a partner-set policy is inherited by its orgs.
 *
 * Strictest-wins: required = roleForce OR settingsRequire. A method is allowed
 * unless effective settings explicitly disable it. Passkey is always allowed —
 * it is phishing-resistant, so a tenant may restrict totp/sms but never the
 * strongest factor.
 *
 * Kill switch (MFA_FORCE_FOR_PARTNER_ADMIN=false) suppresses ONLY the
 * role-driven force (the env flag is named/documented for the partner-admin
 * role force). Org/partner settings-driven requireMfa is STILL enforced when
 * the kill switch is off — it does not collapse required to false globally.
 * `killSwitchOff` in the result therefore means "role-force suppressed".
 * allowedMethods is unaffected.
 *
 * Reads run under a system context (role join + settings touch cross-tenant
 * tables) via runOutsideDbContext+withSystemDbAccessContext so this is correct
 * whether the caller is pre-request-context (middleware/login) or inside a
 * user-scoped request context (factor completion). Settings-read errors fail
 * OPEN (not required, methods allowed) and emit bounded telemetry
 * (captureException) — a transient blip must not mass-lock a tenant nor reject
 * a factor that was allowed at enrollment. Only the SETTINGS read is fail-open;
 * the role/membership join is deliberately NOT wrapped — it shares the login
 * path's normal DB dependency, so a role-join failure is an intentional hard
 * error (failing the request is correct, not the optional-enrichment case the
 * settings fail-open covers). Do not add a try/catch around the role join.
 */
export interface MfaPolicyInput {
  scope: 'system' | 'partner' | 'organization';
  userId: string;
  orgId: string | null;
  partnerId: string | null;
}
export interface MfaAllowedMethods { totp: boolean; sms: boolean; passkey: boolean }
export interface EffectiveMfaPolicy {
  required: boolean;
  allowedMethods: MfaAllowedMethods;
  source: { roleForceMfa: boolean; settingsRequireMfa: boolean; killSwitchOff: boolean };
}

interface SecuritySettings {
  requireMfa?: boolean;
  allowedMethods?: { totp?: boolean; sms?: boolean };
}

function methodsFromSettings(security: SecuritySettings | undefined): MfaAllowedMethods {
  const am = security?.allowedMethods;
  return {
    totp: am?.totp !== false,
    sms: am?.sms !== false,
    passkey: true, // always allowed — phishing-resistant
  };
}

export async function getEffectiveMfaPolicy(input: MfaPolicyInput): Promise<EffectiveMfaPolicy> {
  const killSwitchOff = !mfaForcePartnerAdmin();

  if (input.scope === 'system') {
    return {
      required: false,
      allowedMethods: { totp: true, sms: true, passkey: true },
      source: { roleForceMfa: false, settingsRequireMfa: false, killSwitchOff },
    };
  }

  return dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(async () => {
      // --- role force_mfa ---
      let roleForceMfa = false;
      if (input.scope === 'organization' && input.orgId) {
        const [row] = await dbModule.db
          .select({ forceMfa: roles.forceMfa })
          .from(organizationUsers)
          .innerJoin(roles, eq(organizationUsers.roleId, roles.id))
          .where(and(eq(organizationUsers.userId, input.userId), eq(organizationUsers.orgId, input.orgId)))
          .limit(1);
        roleForceMfa = row?.forceMfa === true;
      } else if (input.scope === 'partner' && input.partnerId) {
        const [row] = await dbModule.db
          .select({ forceMfa: roles.forceMfa })
          .from(partnerUsers)
          .innerJoin(roles, eq(partnerUsers.roleId, roles.id))
          .where(and(eq(partnerUsers.userId, input.userId), eq(partnerUsers.partnerId, input.partnerId)))
          .limit(1);
        roleForceMfa = row?.forceMfa === true;
      }

      // --- effective settings (partner-inherited for org scope) ---
      let security: SecuritySettings | undefined;
      try {
        if (input.scope === 'organization' && input.orgId) {
          const { effective } = await getEffectiveOrgSettings(input.orgId);
          security = effective.security as SecuritySettings | undefined;
        } else if (input.scope === 'partner' && input.partnerId) {
          const [partner] = await dbModule.db
            .select({ settings: partners.settings })
            .from(partners)
            .where(eq(partners.id, input.partnerId))
            .limit(1);
          const settings = (partner?.settings ?? {}) as Record<string, unknown>;
          security = settings.security as SecuritySettings | undefined;
        }
      } catch (err) {
        console.error('[mfa-policy] effective settings read failed — failing open (not required):', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        security = undefined;
      }

      const settingsRequireMfa = security?.requireMfa === true;
      // Kill switch suppresses ONLY the role-force component; settings-driven
      // requireMfa is enforced regardless (overseer hardening decision).
      const roleForceApplies = roleForceMfa && !killSwitchOff;
      const required = roleForceApplies || settingsRequireMfa;

      return {
        required,
        allowedMethods: methodsFromSettings(security),
        source: { roleForceMfa, settingsRequireMfa, killSwitchOff },
      };
    }),
  );
}
```

> Confirm the exact schema import paths before running: `roles`, `organizationUsers`, `partnerUsers` live in `db/schema/users.ts`; `partners` in `db/schema/orgs.ts`. `mfaForcePartnerAdmin` is exported from `config/env.ts`. If a name differs, match the existing `middleware/auth.ts` imports (it imports `roles`, `organizationUsers`, `partnerUsers`).

- [ ] **Step 4: Barrel export**

In `apps/api/src/services/index.ts`, after the `getRefreshFamily` re-export (`:21`), add:

```ts
export { getEffectiveMfaPolicy } from './mfaPolicy';
export type { EffectiveMfaPolicy, MfaPolicyInput, MfaAllowedMethods } from './mfaPolicy';
```

- [ ] **Step 5: Run to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/mfaPolicy.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/mfaPolicy.ts apps/api/src/services/mfaPolicy.test.ts apps/api/src/services/index.ts
git commit -m "feat(auth): add effective MFA policy resolver (SR2-05)"
```

---

### Task 2: Canonicalize `allowedMethods` (fix inert allowlist)

**Files:**
- Modify: `apps/api/src/routes/auth/phone.ts:205-217` (SMS-enable org-allow reader)
- Modify: `apps/api/src/routes/orgs.ts:382` (security schema) + `:1266-1280` (org settings write) + `/partners/me` PATCH security deep-merge (`:619-622`)
- Test: `apps/api/src/routes/auth/phone.test.ts` (create if absent) + `apps/api/src/routes/orgs.test.ts`

**Interfaces:**
- Consumes: `getEffectiveMfaPolicy` (Task 1).
- Produces: `/mfa/sms/enable` rejects when `getEffectiveMfaPolicy(...).allowedMethods.sms === false` (reading the CANONICAL `security.allowedMethods`, never the never-written `allowedMfaMethods`). Org/partner settings writers accept `security.allowedMfaMethods` as an input alias and fold it into `security.allowedMethods`, never persisting the alias key.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/routes/auth/phone.test.ts` (follow the file's existing mock shape; if the file is absent, model it on `auth/login.test.ts`'s harness): a test that mocks `getEffectiveMfaPolicy` to return `allowedMethods.sms=false` and asserts `POST /mfa/sms/enable` returns 403 with `Your organization does not allow SMS MFA`; and a test with `sms=true` that passes the allow-check. Mock the boundary `vi.mock('../../services/mfaPolicy', () => ({ getEffectiveMfaPolicy: vi.fn() }))`.

Add to `apps/api/src/routes/orgs.test.ts`: a settings PATCH that sends `security.allowedMfaMethods={ sms:false }` and asserts the persisted `settings.security.allowedMethods.sms === false` AND `settings.security.allowedMfaMethods` is `undefined` (alias not stored). Follow the file's existing Drizzle-mock capture of the `update().set()` payload.

- [ ] **Step 2: Run to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth/phone.test.ts src/routes/orgs.test.ts -t 'allowed'
```
Expected: FAIL — SMS enable reads the never-written `allowedMfaMethods` (always undefined → SMS never blocked); alias is stored verbatim.

- [ ] **Step 3: Implement — phone.ts reader**

In `apps/api/src/routes/auth/phone.ts`, add the import near the top-of-file imports:

```ts
import { getEffectiveMfaPolicy } from '../../services/mfaPolicy';
```

Replace the org-policy block (`:205-217`, the `if (auth.orgId) { … allowedMfaMethods … }`) with:

```ts
  // Enforce the CANONICAL allowlist through the resolver (partner-inherited).
  // The old reader consulted `security.allowedMfaMethods`, a spelling that is
  // written nowhere → the SMS restriction silently no-opped. Passkey is always
  // allowed; only totp/sms are gated by effective settings.
  const policy = await getEffectiveMfaPolicy({
    scope: auth.scope,
    userId: auth.user.id,
    orgId: auth.orgId ?? null,
    partnerId: auth.partnerId ?? null,
  });
  if (!policy.allowedMethods.sms) {
    return c.json({ error: 'Your organization does not allow SMS MFA' }, 403);
  }
```

(`auth.scope`, `auth.orgId`, `auth.partnerId` are on the `AuthContext` set by `authMiddleware`.)

- [ ] **Step 3b: Implement — orgs.ts input alias**

In `apps/api/src/routes/orgs.ts`, add the alias to the security zod object (`:382`, inside `partnerSettingsSchema.security`), right after the `allowedMethods` line (`:387`):

```ts
    allowedMethods: z.object({ totp: z.boolean().optional(), sms: z.boolean().optional() }).optional(),
    // Legacy input alias. Accepted so older clients don't 400, folded into
    // `allowedMethods` at write time (foldAllowedMfaMethodsAlias) and never
    // persisted as a second source of truth.
    allowedMfaMethods: z.object({ totp: z.boolean().optional(), sms: z.boolean().optional() }).optional(),
```

Add a normalizer near the top of `orgs.ts` (after the imports, before the first route):

```ts
/**
 * Fold the legacy `security.allowedMfaMethods` input alias into the canonical
 * `security.allowedMethods` and drop the alias key so it is never persisted.
 * Canonical wins on conflict. Mutates and returns the same settings object.
 */
function foldAllowedMfaMethodsAlias(settings: unknown): unknown {
  if (!settings || typeof settings !== 'object') return settings;
  const s = settings as Record<string, unknown>;
  const security = s.security;
  if (!security || typeof security !== 'object') return settings;
  const sec = security as Record<string, unknown>;
  if (sec.allowedMfaMethods && typeof sec.allowedMfaMethods === 'object') {
    sec.allowedMethods = {
      ...(sec.allowedMfaMethods as Record<string, unknown>),
      ...((sec.allowedMethods as Record<string, unknown> | undefined) ?? {}),
    };
    delete sec.allowedMfaMethods;
  }
  return settings;
}
```

Apply it in the org settings write (`updateOrgHandler`, `:1238`) — immediately after `const settingsObj = data.settings as Record<string, unknown>;`:

```ts
    foldAllowedMfaMethodsAlias(data.settings);
```

Apply it in the `/partners/me` PATCH security deep-merge (`:619`) — replace the `if (body.settings?.security) { newSettings.security = { … } }` block's assignment so the alias is folded first:

```ts
  if (body.settings?.security) {
    foldAllowedMfaMethodsAlias(body.settings); // canonicalize before deep-merge
    newSettings.security = {
      ...((currentSettings.security as Record<string, unknown> | undefined) ?? {}),
      ...body.settings.security,
    };
  }
```

> Sweep note (CLAUDE.md rule 7): after implementing, `grep -rn "allowedMfaMethods" apps/api/src` — the ONLY remaining reference must be the schema alias + the normalizer. If any other reader survives, it is reading the dead field; route it through the resolver instead.

- [ ] **Step 4: Run to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth/phone.test.ts src/routes/orgs.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/phone.ts apps/api/src/routes/orgs.ts apps/api/src/routes/auth/phone.test.ts apps/api/src/routes/orgs.test.ts
git commit -m "feat(auth): enforce canonical MFA allowedMethods; accept legacy alias as input (SR2-05)"
```

---

### Task 3: Enrollment enforcement via the resolver

**Files:**
- Modify: `apps/api/src/middleware/auth.ts:482-511` (enrollment gate)
- Modify: `apps/api/src/routes/auth/login.ts:486-533` (mfaSatisfied + forced-enrollment response)
- Test: `apps/api/src/middleware/auth.test.ts`, `apps/api/src/routes/auth/login.test.ts`

**Interfaces:**
- Consumes: `getEffectiveMfaPolicy` (Task 1).
- Produces: middleware enrollment gate uses `getEffectiveMfaPolicy(...).required` (so org/partner `requireMfa` now forces enrollment, not just role force). Login never mints `mfa=true` for an unenrolled user when policy requires MFA; it mints `mfa=false` and returns a `mfaEnrollmentRequired` signal so the client routes to setup (the middleware exempt paths still let them reach `/auth/mfa/*`). Kill-switch + exempt paths preserved (both live inside the resolver / the existing gate).

- [ ] **Step 1: Write the failing tests**

`auth.test.ts`: with `getEffectiveMfaPolicy` mocked to `{ required: true }` and a user with `mfaEnabled=false` hitting a non-exempt path → 428 `mfa_enrollment_required`; with `required=false` → passes through. (Mock `vi.mock('../services/mfaPolicy', …)`; keep the existing `mfaForcePartnerAdmin`/`userRoleRequiresMfa` mocks only if still referenced.)

`login.test.ts`: mock `getEffectiveMfaPolicy` to `{ required: true, allowedMethods:{totp:true,sms:true,passkey:true} }`; a login for an unenrolled user (`mfaEnabled=false`) → 200, response body has `mfaEnrollmentRequired: true`, and the payload passed to the mocked `createTokenPair` has `mfa: false` (assert via `expect(createTokenPair).toHaveBeenCalledWith(expect.objectContaining({ mfa: false }), …)`). With `required: false` → `mfa: true` as today. Mock the boundary `vi.mock('../../services/mfaPolicy', () => ({ getEffectiveMfaPolicy: vi.fn() }))` and `import { getEffectiveMfaPolicy } from '../../services/mfaPolicy'` in the test.

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/middleware/auth.test.ts src/routes/auth/login.test.ts -t 'enrollment'
```
Expected: FAIL — gate still calls `userRoleRequiresMfa` (org/partner requireMfa ignored); login still mints vacuous `mfa=true`.

- [ ] **Step 3: Implement — middleware gate**

In `apps/api/src/middleware/auth.ts`, add the import (top of file, with the other `../services` imports):

```ts
import { getEffectiveMfaPolicy } from '../services/mfaPolicy';
```

Replace the enrollment-gate body (`:482-511`, the `if (ENABLE_2FA && !user.mfaEnabled) { … }`) so `requiresMfa` comes from the resolver. **Check the exempt path FIRST** and only call the resolver for non-exempt paths — the resolver now runs an extra `getEffectiveOrgSettings` query, and hot polled exempt routes (`/users/me`, `/auth/mfa/*`) must not pay that DB cost on every request (the US DB has a ~25-connection ceiling):

```ts
  if (ENABLE_2FA && !user.mfaEnabled && !isMfaEnrollmentExemptPath(c.req.path)) {
    const policy = await getEffectiveMfaPolicy({
      scope: payload.scope,
      userId: user.id,
      orgId: payload.orgId,
      partnerId: payload.partnerId,
    });

    if (policy.required) {
      writeAuditEvent(c, {
        orgId: payload.orgId ?? null,
        action: 'auth.mfa.enrollment.required',
        resourceType: 'user',
        resourceId: user.id,
        actorType: 'user',
        actorId: user.id,
        actorEmail: user.email,
        result: 'denied',
        details: { path: c.req.path, scope: payload.scope, source: policy.source },
      });
      return c.json({ error: 'mfa_enrollment_required', enrollUrl: '/auth/mfa/setup' }, 428);
    }
  }
```

The now-unused `userRoleRequiresMfa` function (`:125-169`) becomes dead code — **delete it and its call** (grep to confirm no other caller: `grep -rn "userRoleRequiresMfa" apps/api/src`; `getMfaFactorState` in passkeys.ts uses an inline SQL EXISTS, not this function, so it is unaffected).

- [ ] **Step 3b: Implement — login forced-enrollment response**

In `apps/api/src/routes/auth/login.ts`, add the import to the `'../../services/…'` area:

```ts
import { getEffectiveMfaPolicy } from '../../services/mfaPolicy';
```

Replace the `mfaSatisfied` computation (`:492-493`) and thread the enrollment flag. After `const scope = context.scope;` (`:489`):

```ts
  // Resolve effective policy. A user who reaches here is NOT MFA-enrolled (the
  // enrolled branch above returns early). If policy requires MFA we must NOT
  // grant vacuous assurance: mint mfa=false and tell the client to enroll. The
  // middleware exempt paths (/auth/mfa/*, /users/me) still admit the enrollment
  // flow; every other route 428s until they enroll.
  const policy = await getEffectiveMfaPolicy({ scope, userId: user.id, orgId, partnerId });
  const mfaEnrollmentRequired = ENABLE_2FA && !user.mfaEnabled && policy.required;
  const mfaSatisfied = !ENABLE_2FA || (!user.mfaEnabled && !policy.required);
```

The `createTokenPair({ … mfa: mfaSatisfied … })` call already exists (`:526`); leave `mfa: mfaSatisfied`. Then add `mfaEnrollmentRequired` + `enrollUrl` to the success response body (find the `return c.json({ user: {…}, tokens: … })` for the password-login success and add):

```ts
      mfaEnrollmentRequired,
      enrollUrl: mfaEnrollmentRequired ? '/auth/mfa/setup' : undefined,
```

- [ ] **Step 4: Run to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/middleware/auth.test.ts src/routes/auth/login.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/auth.ts apps/api/src/routes/auth/login.ts apps/api/src/middleware/auth.test.ts apps/api/src/routes/auth/login.test.ts
git commit -m "feat(auth): enforce MFA enrollment via effective policy; no vacuous mfa=true (SR2-05)"
```

---

### Task 4: Epoch/status-bound pending MFA (SR2-06)

**Files:**
- Modify: `apps/api/src/routes/auth/helpers.ts` (add `PendingMfaRecord` type + `parsePendingMfa` + `evaluatePendingMfa`)
- Modify: `apps/api/src/routes/auth/login.ts:447-455` (write the enriched pending record)
- Modify: `apps/api/src/routes/auth/mfa.ts:127-214` (TOTP/SMS verify — validate before mint)
- Modify: `apps/api/src/routes/auth/passkeys.ts:505-531` (`readPendingPasskeyMfa`) + `:277-360` (passkey verify — validate before mint)
- Test: `apps/api/src/routes/auth/helpers.test.ts`, `login.test.ts`, `auth.passkeys.test.ts`, and the main `auth.test.ts` (TOTP verify)

**Interfaces:**
- Produces (in `helpers.ts`):
  ```ts
  export interface PendingMfaRecord {
    userId: string;
    mfaMethod: 'totp' | 'sms' | 'passkey';
    passkeyAvailable: boolean;
    authEpoch: number;
    mfaEpoch: number;
    statusExpectation: string;           // user.status captured at login
    allowedMethods: { totp: boolean; sms: boolean; passkey: boolean };
    expiresAt: number;                   // epoch ms
  }
  // Strict parser: legacy bare-userId / epoch-less records return null → callers
  // reject with the generic "Invalid or expired MFA session" (in-flight legacy
  // records disappear within the 5-min TTL; forcing re-login is correct).
  export function parsePendingMfa(raw: string): PendingMfaRecord | null;
  export function evaluatePendingMfa(
    record: PendingMfaRecord,
    live: { status: string; authEpoch: number; mfaEpoch: number },
  ): { ok: true } | { ok: false; reason: 'expired' | 'epoch_mismatch' | 'status_changed' };
  ```
- Decision: method-still-allowed is checked separately at the call site against the resolver (`policy.allowedMethods[effectiveMethod]`), because `evaluatePendingMfa` is pure and does not do IO.

- [ ] **Step 1: Write the failing tests**

`helpers.test.ts`: `parsePendingMfa` on a full JSON record round-trips; on a bare userId string returns null; on JSON missing `authEpoch` returns null. `evaluatePendingMfa`: returns `ok:false reason:'epoch_mismatch'` when `record.mfaEpoch !== live.mfaEpoch`; `status_changed` when `live.status!=='active'` or differs from expectation; `expired` when `expiresAt <= Date.now()`; `ok:true` otherwise.

`auth.test.ts` (TOTP verify, Case 1): with a valid pending record but the live user's `mfaEpoch` advanced past `record.mfaEpoch` → 401 generic `Invalid or expired MFA session`, `createTokenPair` NOT called, and the pending key IS deleted (consumed). With matching epochs + valid code → 200.

`auth.passkeys.test.ts`: passkey verify rejects on epoch mismatch the same way.

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth/helpers.test.ts src/routes/auth.test.ts src/routes/auth.passkeys.test.ts -t 'pending'
```
Expected: FAIL — no `parsePendingMfa`/`evaluatePendingMfa`; completion paths do not compare epochs.

- [ ] **Step 3: Implement — helpers**

Add to `apps/api/src/routes/auth/helpers.ts`:

```ts
export interface PendingMfaRecord {
  userId: string;
  mfaMethod: 'totp' | 'sms' | 'passkey';
  passkeyAvailable: boolean;
  authEpoch: number;
  mfaEpoch: number;
  statusExpectation: string;
  allowedMethods: { totp: boolean; sms: boolean; passkey: boolean };
  expiresAt: number;
}

/**
 * Strict parse of a `mfa:pending:<tempToken>` value. Returns null for the
 * legacy bare-userId form or any record missing the epoch/status binding
 * (SR2-06): those predate this rollout and must force a fresh login rather than
 * complete with no live re-check.
 */
export function parsePendingMfa(raw: string): PendingMfaRecord | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null; // legacy bare-userId string
  }
  const method = parsed.mfaMethod;
  const am = parsed.allowedMethods as Record<string, unknown> | undefined;
  if (
    typeof parsed.userId !== 'string' ||
    (method !== 'totp' && method !== 'sms' && method !== 'passkey') ||
    typeof parsed.authEpoch !== 'number' ||
    typeof parsed.mfaEpoch !== 'number' ||
    typeof parsed.statusExpectation !== 'string' ||
    typeof parsed.expiresAt !== 'number' ||
    !am || typeof am !== 'object'
  ) {
    return null;
  }
  return {
    userId: parsed.userId,
    mfaMethod: method,
    passkeyAvailable: parsed.passkeyAvailable === true,
    authEpoch: parsed.authEpoch,
    mfaEpoch: parsed.mfaEpoch,
    statusExpectation: parsed.statusExpectation,
    allowedMethods: {
      totp: am.totp !== false,
      sms: am.sms !== false,
      passkey: am.passkey !== false,
    },
    expiresAt: parsed.expiresAt,
  };
}

/**
 * Compare a pending record against the live user row. MFA assurance is valid
 * only for the current MFA config + status (invariants 6/7). Any factor change
 * bumps mfa_epoch; any account-wide change bumps auth_epoch; a suspend flips
 * status — all of which must invalidate an in-flight MFA session.
 */
export function evaluatePendingMfa(
  record: PendingMfaRecord,
  live: { status: string; authEpoch: number; mfaEpoch: number },
): { ok: true } | { ok: false; reason: 'expired' | 'epoch_mismatch' | 'status_changed' } {
  if (record.expiresAt <= Date.now()) return { ok: false, reason: 'expired' };
  if (record.authEpoch !== live.authEpoch || record.mfaEpoch !== live.mfaEpoch) {
    return { ok: false, reason: 'epoch_mismatch' };
  }
  if (live.status !== 'active' || record.statusExpectation !== live.status) {
    return { ok: false, reason: 'status_changed' };
  }
  return { ok: true };
}
```

- [ ] **Step 3b: Implement — login writes the enriched record**

In `login.ts`, the MFA-required branch (`:432-455`). It already has `context` (`:375`) so `context.scope/orgId/partnerId` are available. Resolve epochs + policy and write the full record. Replace the `getRedis()!.setex('mfa:pending:…', 300, JSON.stringify({ userId, mfaMethod, passkeyAvailable }))` (`:447`) with:

```ts
    const pendingEpochs = await getUserEpochs(user.id);
    if (!pendingEpochs) {
      await floorPromise;
      return c.json(genericAuthError(), 401);
    }
    const pendingPolicy = await getEffectiveMfaPolicy({
      scope: context.scope, userId: user.id, orgId: context.orgId, partnerId: context.partnerId,
    });
    const PENDING_TTL_SECONDS = 300;
    const pendingRecord = {
      userId: user.id,
      mfaMethod,
      passkeyAvailable,
      authEpoch: pendingEpochs.authEpoch,
      mfaEpoch: pendingEpochs.mfaEpoch,
      statusExpectation: user.status,
      allowedMethods: pendingPolicy.allowedMethods,
      expiresAt: Date.now() + PENDING_TTL_SECONDS * 1000,
    };
    await getRedis()!.setex(`mfa:pending:${tempToken}`, PENDING_TTL_SECONDS, JSON.stringify(pendingRecord));
```

(`getEffectiveMfaPolicy` is imported in Task 3; `getUserEpochs` already imported. `user.status` is on the loaded row.)

- [ ] **Step 3c: Implement — TOTP/SMS verify validates before mint**

In `mfa.ts` Case 1 (`:127-214`). Replace the ad-hoc pending parse (`:133-144`) with `parsePendingMfa`, and after loading the live `user` (`:154-160`) + before verifying the code, evaluate epochs/status and method-allowed. Import `parsePendingMfa`, `evaluatePendingMfa` (add to the `'./helpers'` import list) and `getEffectiveMfaPolicy` (from `'../../services/mfaPolicy'`). Note: `auditUserLoginFailure` (used by the snippets below) is ALREADY imported from `'./helpers'` at mfa.ts:38 and already used at :203 — do NOT add a second import (redeclaration error).

Replace `:133-144`:

```ts
    const pending = parsePendingMfa(pendingRaw);
    if (!pending) {
      return c.json({ error: 'Invalid or expired MFA session' }, 401);
    }
    const pendingUserId = pending.userId;
    const pendingMfaMethod = pending.mfaMethod;
```

After the live `user` load (`:162`) and before `const effectiveMethod = pendingMfaMethod;` (`:167`), add the binding check. HOIST the `resolveCurrentUserTokenContext(user.id)` call (which the mint currently makes at `:217` to build `mfaContext`) to here so it runs ONCE and its scope/orgId/partnerId feed both the policy check and the token mint below. The audit reason is specific; the public error is generic:

```ts
    const liveEpochs = await getUserEpochs(user.id);
    const verdict = liveEpochs
      ? evaluatePendingMfa(pending, { status: user.status, authEpoch: liveEpochs.authEpoch, mfaEpoch: liveEpochs.mfaEpoch })
      : ({ ok: false, reason: 'epoch_mismatch' } as const);
    if (!verdict.ok) {
      // Consume the record so a rejected session can't be retried.
      await redis.del(`mfa:pending:${tempToken}`);
      void auditUserLoginFailure(c, {
        userId: user.id, email: user.email, name: user.name,
        reason: 'mfa_pending_invalidated',
        details: { phase: verdict.reason, method: pendingMfaMethod },
      });
      return c.json({ error: 'Invalid or expired MFA session' }, 401);
    }

    // Resolve the user's token context ONCE (reused for the mint below, which
    // no longer re-resolves it at :217).
    const mfaContext = await resolveCurrentUserTokenContext(user.id);

    // Method must still be allowed by current policy (a factor could have been
    // disallowed since login). Passkey is handled by its own route; here we gate
    // totp/sms. Use the real scope/org/partner from the resolved context so
    // org- and partner-scoped policy resolves correctly.
    const livePolicy = await getEffectiveMfaPolicy({
      scope: mfaContext.scope,
      userId: user.id,
      orgId: mfaContext.orgId,
      partnerId: mfaContext.partnerId,
    });
    if ((pendingMfaMethod === 'sms' && !livePolicy.allowedMethods.sms) ||
        (pendingMfaMethod === 'totp' && !livePolicy.allowedMethods.totp)) {
      await redis.del(`mfa:pending:${tempToken}`);
      void auditUserLoginFailure(c, {
        userId: user.id, email: user.email, name: user.name,
        reason: 'mfa_method_not_allowed', details: { method: pendingMfaMethod },
      });
      return c.json({ error: 'This MFA method is no longer permitted. Please sign in again.' }, 401);
    }
```

> Note: because `mfaContext` is now resolved here, DELETE the later `const mfaContext = await resolveCurrentUserTokenContext(user.id);` at `:217` and reuse this hoisted binding for the mint (`mfaRoleId`/`mfaPartnerId`/`mfaOrgId`/`mfaScope` are still derived from `mfaContext` exactly as before). One lookup, no contradiction between this snippet and the mint.

The existing `redis.del` at `:214` (before mint) stays — it is the atomic consume on the success path. Leave the code-verification and mint below unchanged (they already mint epoch-valid tokens from PR 1).

- [ ] **Step 3d: Implement — passkey verify validates before mint**

In `passkeys.ts`, extend `readPendingPasskeyMfa` (`:505-531`) to reuse `parsePendingMfa` so the pending object carries the epoch/status fields, and change `PendingPasskeyMfa` to `PendingMfaRecord`. Simplest: replace the body with:

```ts
async function readPendingPasskeyMfa(tempToken: string): Promise<PendingMfaRecord | null> {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get(`mfa:pending:${tempToken}`);
  if (!raw) return null;
  return parsePendingMfa(raw);
}
```

Import `parsePendingMfa`, `evaluatePendingMfa`, `getUserEpochs` (already imported). In the passkey verify handler (`:277-336`), after the existing `if (user.status !== 'active')` check (`:304`) add the epoch binding (the status check already exists — keep it; add epochs):

```ts
  const liveEpochs = await getUserEpochs(user.id);
  const verdict = liveEpochs
    ? evaluatePendingMfa(pending, { status: user.status, authEpoch: liveEpochs.authEpoch, mfaEpoch: liveEpochs.mfaEpoch })
    : ({ ok: false, reason: 'epoch_mismatch' } as const);
  if (!verdict.ok) {
    await redis.del(`mfa:pending:${tempToken}`);
    return c.json({ error: 'Invalid or expired MFA session' }, 401);
  }
```

Passkey is always an allowed method (Task 1), so no method-allowed gate is needed here. The existing `redis.del` at `:360` remains the success-path consume.

`pendingAllowsPasskey(pending)` (used at `:235`/`:282`) reads `pending.passkeyAvailable` / method — it still works against `PendingMfaRecord` (same fields). Confirm its implementation references only `userId`/`mfaMethod`/`passkeyAvailable`; if it narrows to the old `PendingPasskeyMfa` type name, update the type reference.

- [ ] **Step 4: Run to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth/helpers.test.ts src/routes/auth.test.ts src/routes/auth.passkeys.test.ts src/routes/auth/login.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/helpers.ts apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/mfa.ts apps/api/src/routes/auth/passkeys.ts apps/api/src/routes/auth/helpers.test.ts apps/api/src/routes/auth.test.ts apps/api/src/routes/auth.passkeys.test.ts
git commit -m "feat(auth): epoch/status-bound pending MFA records (SR2-06)"
```

---

### Task 5: Consuming TOTP setup verifier (SR2-24)

**Files:**
- Modify: `apps/api/src/routes/auth/mfa.ts:303` (setup-confirm) and `:506` (/mfa/enable)
- Test: `apps/api/src/routes/auth.test.ts`

**Interfaces:**
- Consumes: `consumeMFAToken(secret, code, userId)` (`services/mfa.ts` — already imported into mfa.ts).
- Produces: setup-confirm and `/mfa/enable` verify the code with the CONSUMING verifier, so the accepted time step is recorded (`mfa:usedstep:<userId>`) and cannot be replayed at login within its validity window.

- [ ] **Step 1: Write the failing test**

`auth.test.ts`: drive setup-confirm with a valid TOTP code → 200; then assert a login `/mfa/verify` with the SAME code (same time step) for that user is rejected (401) because the step was consumed. Since `consumeMFAToken` is Redis-Lua backed, use the file's existing Redis mock and assert `consumeMFAToken` (mocked) is called for setup-confirm — or, if the suite runs real `services/mfa`, assert the second use returns 401. Minimum viable assertion: `expect(consumeMFAToken).toHaveBeenCalledWith(expect.any(String), code, auth.user.id)` for the setup-confirm path (proves the consuming verifier replaced the plain one).

- [ ] **Step 2: Run to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth.test.ts -t 'setup'
```
Expected: FAIL — setup-confirm calls the plain `verifyMFAToken` (non-consuming), so replay isn't prevented / the mock isn't called.

- [ ] **Step 3: Implement**

In `mfa.ts` setup-confirm (`:303`), replace:

```ts
  const valid = await verifyMFAToken(secret, code);
```
with:
```ts
  // Consuming verifier: record the accepted time step so it cannot be replayed
  // at login within its ~90s validity window (SR2-24). Fails closed if Redis is
  // down (consumeMFAToken returns false).
  const valid = await consumeMFAToken(secret, code, auth.user.id);
```

Apply the identical replacement in `/mfa/enable` (`:506`, same `const valid = await verifyMFAToken(secret, code);` line → `consumeMFAToken(secret, code, auth.user.id)`).

`verifyMFAToken` is now unused in mfa.ts — remove it from the `'../../services'` import list (`:10`) if no other reference remains (`grep -n verifyMFAToken apps/api/src/routes/auth/mfa.ts`).

- [ ] **Step 4: Run to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/mfa.ts apps/api/src/routes/auth.test.ts
git commit -m "feat(auth): consume TOTP time step at MFA setup/enable (SR2-24)"
```

---

### Task 6: Recovery-code login (SR2-09)

**Files:**
- Modify: `apps/api/src/routes/auth/schemas.ts:45-49` (`mfaVerifySchema`)
- Modify: `apps/api/src/routes/auth/mfa.ts:126-284` (recovery branch in Case 1)
- Test: `apps/api/src/routes/auth.test.ts` (unit); concurrency single-winner lives in Task 9 integration.

**Interfaces:**
- Consumes: `hashRecoveryCode(code)` (`helpers.ts` — sha256 of `pepper + ':' + code.trim().toUpperCase()`); `users.mfaRecoveryCodes` (jsonb array of hex hashes); `parsePendingMfa`/`evaluatePendingMfa` (Task 4).
- Produces: `mfaVerifySchema.code` accepts a 6-digit TOTP/SMS code OR the `XXXX-XXXX` recovery form; `method` enum gains `'recovery'`. The verify handler grows a recovery branch that hashes the normalized input and atomically removes exactly one matching hash from `mfaRecoveryCodes` (one winner under concurrency), mints only after BOTH the recovery-code removal AND the pending record are consumed, and audits without any code material.

- [ ] **Step 1: Write the failing tests**

`auth.test.ts`: (a) `mfaVerifySchema` accepts `code: 'ABCD-2345'` with `method:'recovery'` and a 6-digit code with `method:'totp'`; (b) a login `/mfa/verify` with `method:'recovery'` and a code whose hash is in the user's `mfaRecoveryCodes` → 200 and the used hash is removed from the persisted array (assert the `update().set()` payload's `mfaRecoveryCodes` no longer contains it); (c) an unknown recovery code → 401 with no code material in any audit call.

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth/schemas.test.ts src/routes/auth.test.ts -t 'recovery'
```
Expected: FAIL — schema rejects the 9-char code / no `recovery` method; handler has no recovery branch.

- [ ] **Step 3: Implement — schema**

In `apps/api/src/routes/auth/schemas.ts`, replace `mfaVerifySchema` (`:45-49`):

```ts
// TOTP/SMS codes are 6 digits; recovery codes are `XXXX-XXXX` (8 [A-Z0-9]
// with a hyphen). Accept either shape here; the handler routes on `method`.
const totpOrSmsCode = /^\d{6}$/;
const recoveryCode = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/i;
export const mfaVerifySchema = z.object({
  code: z.string().refine(
    (v) => totpOrSmsCode.test(v.trim()) || recoveryCode.test(v.trim()),
    { message: 'Invalid code format' },
  ),
  tempToken: z.string().optional(),
  method: z.enum(['totp', 'sms', 'recovery']).optional(),
});
```

> `mfaDisableSchema = mfaVerifySchema.extend({ currentPassword })` (`mfa.ts:56`) inherits the relaxed `code` — acceptable (disable still verifies a live TOTP/SMS code; a recovery code won't match the TOTP/SMS branch and is rejected there). No change needed to disable.

- [ ] **Step 3b: Implement — recovery branch**

In `mfa.ts` Case 1, after `const effectiveMethod = pendingMfaMethod;` is established and the epoch/status/method checks (Task 4) pass, add a recovery branch that runs when the CLIENT explicitly requests recovery. Read `method` from the validated body (add `method` to the destructure at `:119`: `const { code, tempToken, method } = c.req.valid('json');`).

Insert BEFORE the `if (effectiveMethod === 'sms')` block (`:175`):

```ts
    // Recovery-code login. Independent of the account's primary factor: a user
    // locked out of their authenticator falls back to a stored recovery code.
    // Remove exactly one matching hash with a server-side RELATIVE jsonb delete
    // (`mfaRecoveryCodes - inputHash`) guarded by `@> [inputHash]`. This is the
    // ONLY correct concurrency shape — it composes under READ COMMITTED:
    //   - two concurrent DISTINCT valid codes each delete their OWN element from
    //     the row's committed value (Postgres re-evaluates `-` against the
    //     latest committed array), so both succeed and NEITHER resurrects the
    //     other's hash. A stale read-modify-write (SET = a JS array computed
    //     from a pre-read snapshot) would resurrect the co-winner's hash — never
    //     do that.
    //   - two concurrent IDENTICAL codes serialize on the row; the loser's `@>`
    //     guard fails against the winner's committed value → rowCount 0 → 401.
    // Single-winner AND no-resurrection are proven against real Postgres (Task 9).
    if (method === 'recovery') {
      const inputHash = hashRecoveryCode(code);
      const stored = Array.isArray(user.mfaRecoveryCodes) ? (user.mfaRecoveryCodes as string[]) : [];
      if (!stored.includes(inputHash)) {
        void auditUserLoginFailure(c, {
          userId: user.id, email: user.email, name: user.name,
          reason: 'mfa_recovery_code_invalid', details: { method: 'recovery' },
        });
        return c.json({ error: 'Invalid MFA code' }, 401);
      }
      const removed = await withSystemDbAccessContext(() =>
        db
          .update(users)
          .set({ mfaRecoveryCodes: sql`${users.mfaRecoveryCodes} - ${inputHash}`, updatedAt: new Date() })
          .where(and(eq(users.id, user.id), sql`${users.mfaRecoveryCodes} @> ${JSON.stringify([inputHash])}::jsonb`))
          .returning({ id: users.id }),
      );
      if (removed.length === 0) {
        // A concurrent winner already consumed this exact hash — reject the loser.
        return c.json({ error: 'Invalid MFA code' }, 401);
      }
      writeAuthAudit(c, {
        orgId: undefined,
        action: 'auth.mfa.recovery_code.used',
        result: 'success',
        userId: user.id,
        email: user.email,
        // Best-effort count from the PRE-update snapshot only — never read the
        // post-update array back, and never log the code or its hash.
        details: { remainingApprox: Math.max(0, stored.length - 1) },
      });
      valid = true;
    } else if (effectiveMethod === 'sms') {
      // …existing SMS branch…
```

> Wiring notes: (1) `valid` is already declared `let valid = false;` at `:169`. The recovery branch removes the code hash + sets `valid = true`; it does NOT call `redis.del`. The single existing `await redis.del(\`mfa:pending:${tempToken}\`)` at `:214` consumes the pending record for ALL branches (recovery included), so there is exactly one pending-record consume and no double-delete. The code below `if (!valid)` (`:202`) and the shared mint (`:216-283`) run unchanged. (2) Import `hashRecoveryCode`, `writeAuthAudit` from `'./helpers'`, and `and`, `sql` from `'drizzle-orm'` (add `and`, `sql` to the existing `import { eq } from 'drizzle-orm'` at `mfa.ts:3`). (3) `user.mfaRecoveryCodes` is selected because Case-1 loads `db.select()` (full row) at `:154-160`.

> M3 — DB context: the recovery UPDATE uses a bare `withSystemDbAccessContext` (no `runOutsideDbContext` wrap) because Case-1 tempToken verification is UNAUTHENTICATED — it runs with NO ambient request DB context, so there is nothing to escape first. (Contrast the self-service factor handlers in Task 7, which run inside a request context and therefore must NOT introduce a system wrap.)

- [ ] **Step 4: Run to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth/schemas.test.ts src/routes/auth.test.ts
```
Expected: PASS. (The concurrent single-winner proof is Task 9.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/schemas.ts apps/api/src/routes/auth/mfa.ts apps/api/src/routes/auth/schemas.test.ts apps/api/src/routes/auth.test.ts
git commit -m "feat(auth): recovery-code login with atomic single-use consumption (SR2-09)"
```

---

### Task 7: Factor-change invalidation (SR2-07 / SR2-19)

**Files:**
- Create: `apps/api/src/services/mfaAssurance.ts` + `mfaAssurance.test.ts`
- Modify: factor handlers in `mfa.ts` (`/mfa/enable`, `/mfa/disable`, `/mfa/recovery-codes`), `phone.ts` (`/mfa/sms/enable`, `/phone/confirm` replacement case), `passkeys.ts` (`/passkeys/register/verify`, `DELETE /passkeys/:id`)
- Modify (I3): route the `/mfa/disable` requireMfa BLOCK and the passkey last-factor guard (`getMfaFactorState`) through `getEffectiveMfaPolicy` instead of the direct `organizations.settings` read
- Test: sibling route suites + `mfaAssurance.test.ts`; real-PG atomicity in Task 9.

**Interfaces:**
- Consumes: `advanceUserEpochs`, `revokeAllRefreshFamilies`, `runPostCommitCleanup`, `Tx` (`services/authLifecycle.ts`); `terminateUserRemoteSessions`, `TEARDOWN_FAILED` (`services/remoteSessionTeardown.ts`); `db`, `db.transaction` (`db/index.ts`).
- Produces:
  ```ts
  export interface FactorChangeResult {
    mfaEpoch: number;
    cleanup: import('./authLifecycle').PostCommitCleanupResult;
    remoteSessionsTerminated: number; // >=0, or TEARDOWN_FAILED (-1) = partial op failure
  }
  /**
   * Invalidate all MFA assurance after a factor change. In ONE transaction:
   * runs the optional business `mutate(tx)` (the factor write itself, folded in
   * for atomicity), advances mfa_epoch, and revokes every refresh family. Then
   * post-commit (best-effort, never restores validity): Redis/permission/OAuth
   * cleanup + remote-session teardown. Deliberate global sign-out.
   *
   * Runs under the caller's ambient (user-scoped) request context: writes touch
   * the user's OWN users row + OWN refresh_token_families, which Shape-6 /
   * user-id RLS admits. Do NOT wrap self-service callers in system context.
   */
  export async function invalidateMfaAssuranceAfterFactorChange(
    userId: string,
    reason: string,
    mutate?: (tx: Tx) => Promise<void>,
  ): Promise<FactorChangeResult>;
  ```

- [ ] **Step 1: Write the failing test**

`mfaAssurance.test.ts` (mock `../db` `transaction`, `./authLifecycle`, `./remoteSessionTeardown`): asserts (a) `mutate` runs inside the tx before `advanceUserEpochs(tx, userId, { mfa: true })` and `revokeAllRefreshFamilies(tx, userId, reason)`; (b) post-commit `runPostCommitCleanup(userId)` AND `terminateUserRemoteSessions(userId)` both run; (c) `remoteSessionsTerminated === TEARDOWN_FAILED` is surfaced (not swallowed, not thrown) when teardown returns `-1`; (d) a throw inside `mutate` rejects and neither post-commit step runs (tx rolled back).

- [ ] **Step 2: Run to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/mfaAssurance.test.ts
```
Expected: FAIL — cannot find module `./mfaAssurance`.

- [ ] **Step 3: Implement — service**

Create `apps/api/src/services/mfaAssurance.ts`:

```ts
import * as dbModule from '../db';
import {
  advanceUserEpochs,
  revokeAllRefreshFamilies,
  runPostCommitCleanup,
  type Tx,
  type PostCommitCleanupResult,
} from './authLifecycle';
import { terminateUserRemoteSessions } from './remoteSessionTeardown';

export interface FactorChangeResult {
  mfaEpoch: number;
  cleanup: PostCommitCleanupResult;
  remoteSessionsTerminated: number;
}

/**
 * Invalidate MFA assurance after a factor add/remove/replace/rotate (SR2-07,
 * SR2-19). Atomic durable effect (invariant 3): mutate + mfa_epoch advance +
 * refresh-family revoke commit together or not at all. Post-commit cleanup and
 * remote-session teardown are best-effort — teardown failure is surfaced as a
 * partial operational failure via TEARDOWN_FAILED (-1) but NEVER restores token
 * validity. Runs under the caller's ambient user-scoped context (self-service).
 */
export async function invalidateMfaAssuranceAfterFactorChange(
  userId: string,
  reason: string,
  mutate?: (tx: Tx) => Promise<void>,
): Promise<FactorChangeResult> {
  const epochRow = await dbModule.db.transaction(async (tx: Tx) => {
    if (mutate) await mutate(tx);
    const row = await advanceUserEpochs(tx, userId, { mfa: true });
    await revokeAllRefreshFamilies(tx, userId, reason);
    return row;
  });

  const cleanup = await runPostCommitCleanup(userId);
  const remoteSessionsTerminated = await terminateUserRemoteSessions(userId);

  return { mfaEpoch: epochRow.mfaEpoch, cleanup, remoteSessionsTerminated };
}
```

- [ ] **Step 3b: Wire into every mutating factor handler**

For each handler, MOVE its existing `db.update(users)…`/insert/delete of the factor into the `mutate(tx)` callback so the factor write and the epoch bump/revoke are one transaction, then use the returned `result` to write a single assurance audit. `reason` ≤ 64 chars. Import `invalidateMfaAssuranceAfterFactorChange` and `TEARDOWN_FAILED` in each route file.

**mfa.ts `/mfa/enable`** (`:522-531`): replace the standalone `await db.update(users).set({ mfaEnabled:true, … })` with:
```ts
  const result = await invalidateMfaAssuranceAfterFactorChange(auth.user.id, 'mfa-enable', async (tx) => {
    await tx.update(users).set({
      mfaSecret: encryptMfaSecret(secret), mfaEnabled: true, mfaMethod: 'totp',
      mfaRecoveryCodes: hashRecoveryCodes(recoveryCodes), updatedAt: new Date(),
    }).where(eq(users.id, auth.user.id));
  });
```
(add a `details: { mfaEpoch: result.mfaEpoch, teardownFailed: result.remoteSessionsTerminated === TEARDOWN_FAILED }` line to the existing `auth.mfa.setup` success audit).

**mfa.ts setup-confirm** (`:319-328`): same fold (`reason: 'mfa-setup-confirm'`).

**mfa.ts `/mfa/disable`** (`:441-452`): fold the `mfaSecret:null, mfaEnabled:false, …` update into `mutate` (`reason: 'mfa-disable'`).

**mfa.ts `/mfa/recovery-codes`** (`:572-578`): fold the `mfaRecoveryCodes` rotate into `mutate` (`reason: 'mfa-recovery-rotate'`). Note: rotating recovery codes advances `mfa_epoch` and signs the user out — per SR2-19 this is intended (recovery-code set is part of the MFA config).

**phone.ts `/mfa/sms/enable`** (`:223-232`): fold the enable update into `mutate` (`reason: 'sms-mfa-enable'`).

**phone.ts `/phone/confirm`** (`:150-157`): **replacement-only.** Phone verification during initial SMS enrollment must NOT sign the user out (they still need to call `/mfa/sms/enable`). Only invalidate when this is a *replacement* of a phone backing an ACTIVE SMS factor. Load the current `mfaMethod`/`mfaEnabled` first:
```ts
  const [cur] = await db.select({ mfaEnabled: users.mfaEnabled, mfaMethod: users.mfaMethod })
    .from(users).where(eq(users.id, auth.user.id)).limit(1);
  const isSmsFactorReplacement = cur?.mfaEnabled === true && cur.mfaMethod === 'sms';
  if (isSmsFactorReplacement) {
    await invalidateMfaAssuranceAfterFactorChange(auth.user.id, 'phone-replacement', async (tx) => {
      await tx.update(users).set({ phoneNumber, phoneVerified: true, updatedAt: new Date() }).where(eq(users.id, auth.user.id));
    });
  } else {
    await db.update(users).set({ phoneNumber, phoneVerified: true, updatedAt: new Date() }).where(eq(users.id, auth.user.id));
  }
```

**passkeys.ts `/passkeys/register/verify`** (`:169-208`): fold BOTH the `user_passkeys` insert AND the `users` mfaEnabled update into `mutate`, capturing the inserted row via a closure variable (`reason: 'passkey-register'`):
```ts
  let inserted: typeof userPasskeys.$inferSelect | undefined;
  await invalidateMfaAssuranceAfterFactorChange(auth.user.id, 'passkey-register', async (tx) => {
    const [row] = await tx.insert(userPasskeys).values({ /* …existing fields… */ }).returning();
    if (!row) throw new Error('Passkey insert returned no row');
    inserted = row;
    const [currentMfa] = await tx.select({ mfaSecret: users.mfaSecret, mfaMethod: users.mfaMethod })
      .from(users).where(eq(users.id, auth.user.id)).limit(1);
    const hasExistingFactor = Boolean(currentMfa?.mfaSecret) || currentMfa?.mfaMethod === 'sms';
    await tx.update(users).set({ mfaEnabled: true, ...(hasExistingFactor ? {} : { mfaMethod: 'passkey' }), updatedAt: new Date() })
      .where(eq(users.id, auth.user.id));
  });
```
(use `inserted` in the response `toPublicPasskey(inserted)`).

**passkeys.ts `DELETE /passkeys/:id`** (`:469-491`): fold the `delete(userPasskeys)` + the conditional `users` update into `mutate` (`reason: 'passkey-delete'`). Keep the last-factor guard (`:465`) BEFORE the call.

> DB-context note: all seven handlers are `authMiddleware`-gated and act on the CALLER's own rows, so the ambient user-scoped `db.transaction` inside `invalidateMfaAssuranceAfterFactorChange` is correct (Shape-6 / user-id RLS admits self-writes). `terminateUserRemoteSessions` internally does its own `runOutsideDbContext + withSystemDbAccessContext`, so it is safe to call from within the request context.

- [ ] **Step 3c: Route the disable-block + last-factor guard through the resolver (I3, SR2-05 on the factor surface)**

Both `/mfa/disable` and the passkey last-factor guard currently read `organizations.settings.security.requireMfa` DIRECTLY and only for `auth.orgId` — bypassing partner inheritance and ignoring partner-scope users. Switch both to `getEffectiveMfaPolicy(...).required` so a partner-set `requireMfa` correctly blocks disable / last-factor removal. Import `getEffectiveMfaPolicy` from `'../../services/mfaPolicy'` in both files.

**mfa.ts `/mfa/disable`** — replace the org-policy block (`mfa.ts:361-373`, the `if (auth.orgId) { … const orgSettings = org?.settings … requireMfa … }`) with:

```ts
  // MFA policy blocks self-disable when effective policy (role OR org/partner
  // requireMfa, partner-inherited) still requires MFA for this user. Uses the
  // resolver so a partner-set requireMfa — invisible to the old org-only read —
  // is honored, and partner-scope users are covered.
  const disablePolicy = await getEffectiveMfaPolicy({
    scope: auth.scope,
    userId: auth.user.id,
    orgId: auth.orgId ?? null,
    partnerId: auth.partnerId ?? null,
  });
  if (disablePolicy.required) {
    return c.json({ error: 'Your organization requires MFA. Contact your admin to change this policy.' }, 403);
  }
```

(Remove the now-unused direct `organizations` import from mfa.ts only if no other reference remains — `grep -n organizations src/routes/auth/mfa.ts`.)

**passkeys.ts last-factor guard (`getMfaFactorState`, `:549-603`)** — keep its factor-count logic (`passkeyCount`/`hasTotp`/`hasSms`) exactly, but replace the `mfaRequired` source. Today it derives `mfaRequired` from the inline `forceMfa` EXISTS + the org-only `orgRequiresMfa` EXISTS. Drop the `orgRequiresMfa` SQL sub-select and compute `mfaRequired` from the resolver instead:

```ts
  const policy = await getEffectiveMfaPolicy({
    scope: auth.scope,
    userId: auth.user.id,
    orgId: auth.orgId ?? null,
    partnerId: auth.partnerId ?? null,
  });
  // …run the existing system-context factor-count query (passkeyCount/hasTotp/
  // hasSms/currentMfaMethod) WITHOUT the forceMfa/orgRequiresMfa columns…
  return {
    passkeyCount: Number(state?.passkeyCount ?? 0),
    hasTotp: Boolean(state?.hasTotp),
    hasSms: Boolean(state?.hasSms),
    currentMfaMethod: state?.currentMfaMethod ?? null,
    mfaRequired: policy.required,
  };
```

This closes SR2-05 on the factor-operation surface: a partner-set `requireMfa` now blocks both disable and last-factor removal, matching enrollment/login.

- [ ] **Step 4: Run to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/mfaAssurance.test.ts src/routes/auth.test.ts src/routes/auth.passkeys.test.ts src/routes/auth/phone.test.ts
```
Expected: PASS. (Route suites: update the mocked `db.transaction`/`authLifecycle`/`remoteSessionTeardown` factories to satisfy the new call — mirror the `auth.test.ts` `stubTx()` + `runPostCommitCleanup` mock convention from PR 1; mock `terminateUserRemoteSessions → 0`.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/mfaAssurance.ts apps/api/src/services/mfaAssurance.test.ts apps/api/src/routes/auth/mfa.ts apps/api/src/routes/auth/phone.ts apps/api/src/routes/auth/passkeys.ts apps/api/src/routes/auth.test.ts apps/api/src/routes/auth.passkeys.test.ts apps/api/src/routes/auth/phone.test.ts
git commit -m "feat(auth): invalidate MFA assurance (epoch+family+remote) on factor change (SR2-07,SR2-19)"
```

---

### Task 8: Existing-factor step-up for factor addition (SR2-20)

**Files:**
- Create: `apps/api/src/services/mfaStepUpGrant.ts` + `mfaStepUpGrant.test.ts`
- Modify: `apps/api/src/routes/auth/mfa.ts` (new `POST /auth/mfa/step-up` mint endpoint incl. passkey-assertion proof; grant gate on `/mfa/enable` + setup-confirm) + `apps/api/src/routes/auth/schemas.ts` (discriminated-union step-up schema + `stepUpGrantId` on factor-add schemas)
- Modify: `apps/api/src/routes/auth/passkeys.ts` (new authenticated `POST /auth/mfa/step-up/options` challenge issuer; exported `verifyStepUpPasskeyAssertion` helper; `/passkeys/register/options` + `/verify` require the grant when already protected)
- Modify: `apps/api/src/routes/auth/phone.ts` (`/mfa/sms/enable` grant gate when already protected)
- Modify: `apps/api/src/routes/auth/helpers.ts` (shared `userIsMfaProtected` + `enforceExistingFactorStepUp` route helper, used by all four factor-addition surfaces)
- Test: `mfaStepUpGrant.test.ts`, `auth.test.ts`, `auth.passkeys.test.ts`, `phone.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface StepUpGrant {
    id: string;
    userId: string;
    operation: 'add_factor';
    authEpoch: number;
    mfaEpoch: number;
    sid: string;            // initiating access-token session id
  }
  // Redis key `mfa:stepup:<id>`, TTL 300s.
  export async function mintStepUpGrant(
    input: { userId: string; operation: 'add_factor'; authEpoch: number; mfaEpoch: number; sid: string },
  ): Promise<string | null>;                 // returns grant id, null if Redis down (fail closed at caller)
  export async function validateStepUpGrant(
    id: string, bind: Omit<StepUpGrant, 'id'>,
  ): Promise<boolean>;                        // non-consuming (register/options)
  export async function consumeStepUpGrant(
    id: string, bind: Omit<StepUpGrant, 'id'>,
  ): Promise<boolean>;                        // single-use via getdel (register/verify)
  ```
- Decisions:
  - **SR2-20 is generic to ANY factor addition** (design §"Factor enrollment and changes"). So the grant gates EVERY factor-add surface on an already-protected account, not just passkeys: `/mfa/enable` + setup-confirm (TOTP add/replace), `/mfa/sms/enable` (SMS add), and `/passkeys/register/*` (passkey add). Each keeps its existing `requireCurrentPasswordStepUp` too — password AND a fresh existing-factor proof (design says "additionally").
  - **Initial enrollment (account has NO factor)** keeps today's behavior: current-password step-up only. No grant required (`enforceExistingFactorStepUp` returns null when `!userIsMfaProtected`). Avoids the chicken-and-egg lockout.
  - **Adding a factor to an ALREADY-PROTECTED account** additionally requires a fresh existing-factor proof: the client first calls `POST /auth/mfa/step-up` proving an existing factor, which mints a grant; the factor-add endpoint then requires it. `/passkeys/register/options` uses `validateStepUpGrant` (non-consuming — the same grant is consumed at `/verify`); every terminal factor-write (`/verify`, `/mfa/enable`, setup-confirm, `/mfa/sms/enable`) uses `consumeStepUpGrant` (single-use getdel) at the write point.
  - **Existing-factor proof accepts ALL factor types** so a passkey-ONLY user is not locked out: `POST /auth/mfa/step-up` takes a TOTP code, an SMS code, OR a WebAuthn passkey assertion (discriminated union on `method`). The passkey proof reuses the authentication challenge/verify flow: the client first calls `POST /auth/mfa/step-up/options` (authenticated) to get a challenge, runs a passkey `get()` ceremony, then submits the assertion to `/auth/mfa/step-up` with `method:'passkey'`.
  - Binding: grant `sid` must equal the caller's `auth.token.sid`; `authEpoch`/`mfaEpoch` are re-validated against the LIVE row at validate/consume (any factor change bumps `mfa_epoch` + revokes families → a stale grant is invalid). Fails closed on Redis ambiguity.

- [ ] **Step 1: Write the failing test**

`mfaStepUpGrant.test.ts` (mock `./redis` `getRedis`): `mintStepUpGrant` writes `mfa:stepup:<id>` with TTL 300 and returns the id; `validateStepUpGrant` returns true only when id exists AND all bind fields match, false on any mismatch; `consumeStepUpGrant` uses `getdel` (single-use) — a second consume of the same id returns false; both return false when `getRedis()` is null.

`auth.passkeys.test.ts`: an already-protected account (mock `userIsMfaProtected → true`) calling `/passkeys/register/options` WITHOUT a valid grant → 403; WITH a valid grant → 200. A no-factor account (`userIsMfaProtected → false`) without a grant still → 200 (password-only path preserved).

`auth.test.ts`: (a) already-protected account calling `/mfa/enable` (and setup-confirm) WITHOUT a grant → 403; WITH a consumed grant → succeeds. (b) `/auth/mfa/step-up` with `method:'passkey'` and a valid assertion for a passkey-only user mints a grant (assert `mintStepUpGrant` called) — proving a passkey-only user is not locked out. `phone.test.ts`: already-protected account calling `/mfa/sms/enable` WITHOUT a grant → 403; WITH a grant → succeeds.

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/mfaStepUpGrant.test.ts src/routes/auth.passkeys.test.ts -t 'step-up'
```
Expected: FAIL — module missing; options/verify enforce no grant.

- [ ] **Step 3: Implement — grant service**

Create `apps/api/src/services/mfaStepUpGrant.ts`:

```ts
import { randomUUID } from 'crypto';
import { getRedis } from './redis';

export interface StepUpGrant {
  id: string;
  userId: string;
  operation: 'add_factor';
  authEpoch: number;
  mfaEpoch: number;
  sid: string;
}
type GrantBind = Omit<StepUpGrant, 'id'>;
const TTL_SECONDS = 300;
const key = (id: string) => `mfa:stepup:${id}`;

function bindsMatch(record: GrantBind, bind: GrantBind): boolean {
  return record.userId === bind.userId
    && record.operation === bind.operation
    && record.authEpoch === bind.authEpoch
    && record.mfaEpoch === bind.mfaEpoch
    && record.sid === bind.sid;
}

/** Mint a short-lived single-use step-up grant. Returns null if Redis is down. */
export async function mintStepUpGrant(bind: GrantBind): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  const id = randomUUID();
  await redis.setex(key(id), TTL_SECONDS, JSON.stringify(bind));
  return id;
}

/** Non-consuming check (register/options). Fails closed on Redis error/miss. */
export async function validateStepUpGrant(id: string, bind: GrantBind): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const raw = await redis.get(key(id));
    if (!raw) return false;
    return bindsMatch(JSON.parse(raw) as GrantBind, bind);
  } catch { return false; }
}

/** Single-use consume via getdel (register/verify). Fails closed. */
export async function consumeStepUpGrant(id: string, bind: GrantBind): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const raw = await redis.getdel(key(id));
    if (!raw) return false;
    return bindsMatch(JSON.parse(raw) as GrantBind, bind);
  } catch { return false; }
}
```

- [ ] **Step 3b: Implement — mint endpoint**

In `schemas.ts`, add a discriminated union so a passkey-only user can also prove an existing factor. The passkey assertion is shape-checked here (`.passthrough()`) and cryptographically verified downstream by `verifyPasskeyAuthentication`; do NOT import the passkeys route's `webAuthnCredentialSchema` here (that would create a `schemas.ts` ↔ `passkeys.ts` import cycle):

```ts
const stepUpSixDigit = z.string().refine((v) => /^\d{6}$/.test(v.trim()), { message: 'Invalid code' });
const stepUpAssertion = z.object({ id: z.string().min(1) }).passthrough(); // full WebAuthn assertion
export const mfaStepUpSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('totp'), code: stepUpSixDigit }),
  z.object({ method: z.literal('sms'), code: stepUpSixDigit }),
  z.object({ method: z.literal('passkey'), credential: stepUpAssertion }),
]);

// `stepUpGrantId` added to every factor-ADDITION request schema so an
// already-protected account can present its fresh existing-factor grant.
// Add this field to: mfaEnableWithPasswordSchema (mfa.ts, /mfa/enable),
// mfaVerifySchema (setup-confirm Case 2), smsMfaEnableSchema (phone.ts),
// registerOptionsSchema + registerVerifySchema (passkeys.ts):
//   stepUpGrantId: z.string().optional(),
```

In `passkeys.ts`, add the authenticated challenge issuer and export the assertion-verify helper (keeps ALL WebAuthn machinery in the passkeys module — mfa.ts just calls a boolean helper, no route-local imports leak):

```ts
// Authenticated passkey step-up challenge (mirrors /mfa/passkey/options, but
// keyed on the logged-in user rather than a login tempToken).
passkeyRoutes.post('/mfa/step-up/options', authMiddleware, async (c) => {
  if (!ENABLE_2FA) return mfaDisabledResponse(c);
  const auth = c.get('auth');
  const passkeys = await withSystemDbAccessContext(() => listActivePasskeys(auth.user.id));
  if (passkeys.length === 0) {
    return c.json({ error: 'No passkeys are registered for this account' }, 400);
  }
  const options = await generatePasskeyAuthenticationOptions({
    userId: auth.user.id,
    passkeys: passkeys.map(toStoredCredential),
  });
  return c.json({ options });
});

/**
 * Verify a WebAuthn assertion as proof of an existing passkey factor for the
 * step-up flow. Loads the caller-owned passkey, verifies against the stored
 * authentication challenge, persists the new signature counter (clone
 * detection), and returns whether it verified. Reused by mfa.ts's
 * /auth/mfa/step-up passkey branch. Returns false (never throws) on a
 * challenge/ownership problem.
 */
export async function verifyStepUpPasskeyAssertion(userId: string, credential: { id?: string }): Promise<boolean> {
  const [passkey] = await withSystemDbAccessContext(() =>
    db.select().from(userPasskeys).where(eq(userPasskeys.credentialId, credential?.id ?? '')).limit(1));
  if (!passkey || passkey.userId !== userId || passkey.disabledAt) return false;
  let verification;
  try {
    verification = await verifyPasskeyAuthentication({ userId, response: credential as never, passkey: toStoredCredential(passkey) });
  } catch (err) {
    if (err instanceof PasskeyChallengeError) return false;
    throw err;
  }
  if (!verification.verified) return false;
  const updateFields = authenticationInfoToPasskeyUpdateFields(verification);
  await withSystemDbAccessContext(() =>
    db.update(userPasskeys).set({ counter: updateFields.counter, lastUsedAt: updateFields.lastUsedAt, updatedAt: new Date() }).where(eq(userPasskeys.id, passkey.id)));
  return true;
}
```

In `mfa.ts`, add `POST /auth/mfa/step-up` (authenticated). It verifies the existing factor — `consumeMFAToken` for TOTP, Twilio `checkVerificationCode` for SMS, `verifyStepUpPasskeyAssertion` for passkey — then mints a grant bound to the live epochs + `auth.token.sid`:

```ts
mfaRoutes.post('/mfa/step-up', authMiddleware, zValidator('json', mfaStepUpSchema), async (c) => {
  if (!ENABLE_2FA) return mfaDisabledResponse(c);
  const auth = c.get('auth');
  const body = c.req.valid('json'); // discriminated union on `method`

  let ok = false;
  if (body.method === 'totp') {
    const [u] = await db.select({ mfaSecret: users.mfaSecret }).from(users).where(eq(users.id, auth.user.id)).limit(1);
    const secret = u?.mfaSecret ? decryptMfaSecret(u.mfaSecret) : null;
    ok = !!secret && await consumeMFAToken(secret, body.code, auth.user.id);
  } else if (body.method === 'sms') {
    const [u] = await db.select({ phoneNumber: users.phoneNumber }).from(users).where(eq(users.id, auth.user.id)).limit(1);
    const twilio = getTwilioService();
    if (!twilio || !u?.phoneNumber) return c.json({ error: 'SMS not available' }, 400);
    const r = await twilio.checkVerificationCode(u.phoneNumber, body.code);
    if (r.serviceError) return c.json({ error: 'SMS verification temporarily unavailable' }, 502);
    ok = r.valid;
  } else {
    // passkey — client must have called POST /auth/mfa/step-up/options first.
    ok = await verifyStepUpPasskeyAssertion(auth.user.id, body.credential);
  }
  if (!ok) {
    writeAuthAudit(c, { orgId: auth.orgId ?? undefined, action: 'auth.mfa.stepup.failed', result: 'failure', reason: 'invalid_factor', userId: auth.user.id, email: auth.user.email, details: { method: body.method } });
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const epochs = await getUserEpochs(auth.user.id);
  if (!epochs || !auth.token.sid) return c.json({ error: 'Service temporarily unavailable' }, 503);
  const grantId = await mintStepUpGrant({
    userId: auth.user.id, operation: 'add_factor',
    authEpoch: epochs.authEpoch, mfaEpoch: epochs.mfaEpoch, sid: auth.token.sid,
  });
  if (!grantId) return c.json({ error: 'Service temporarily unavailable' }, 503);
  writeAuthAudit(c, { orgId: auth.orgId ?? undefined, action: 'auth.mfa.stepup.granted', result: 'success', userId: auth.user.id, email: auth.user.email, details: { method: body.method, operation: 'add_factor' } });
  return c.json({ stepUpGrantId: grantId });
});
```

Import `mintStepUpGrant` from `'../../services/mfaStepUpGrant'`, `mfaStepUpSchema` from `'./schemas'`, `verifyStepUpPasskeyAssertion` from `'./passkeys'`, `getTwilioService` (already imported). (mfa.ts importing from the sibling passkeys route module is fine — passkeys.ts does not import mfa.ts, so no cycle.)

- [ ] **Step 3c: Implement — shared gate helper + passkey register**

Add ONE shared helper to `routes/auth/helpers.ts` so all four factor-add surfaces gate identically (import `getUserEpochs` from `'../../services'`, `validateStepUpGrant`/`consumeStepUpGrant` from `'../../services/mfaStepUpGrant'`, `withSystemDbAccessContext`/`db` as the file already does):

```ts
/** True when the account already has any MFA factor (TOTP/SMS/passkey). */
export async function userIsMfaProtected(userId: string): Promise<boolean> {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({
      mfaEnabled: users.mfaEnabled,
      passkeyCount: sql<number>`(SELECT COUNT(*)::int FROM user_passkeys WHERE user_id = ${userId} AND disabled_at IS NULL)`,
    }).from(users).where(eq(users.id, userId)).limit(1));
  return row?.mfaEnabled === true || Number(row?.passkeyCount ?? 0) > 0;
}

/**
 * Enforce the SR2-20 existing-factor step-up on a factor-ADDITION endpoint.
 * No-factor accounts (initial enrollment) pass with password-only (returns
 * null). Already-protected accounts must present a fresh grant bound to the
 * live epochs + this session's sid. `consume:false` = validate (register
 * options); `consume:true` = single-use consume (every terminal factor write).
 * Returns a 403/503 Response to short-circuit, or null to proceed.
 */
export async function enforceExistingFactorStepUp(
  c: Context, auth: AuthContext, grantId: string | undefined, opts: { consume: boolean },
): Promise<Response | null> {
  if (!(await userIsMfaProtected(auth.user.id))) return null;
  const epochs = await getUserEpochs(auth.user.id);
  if (!epochs || !auth.token.sid) return c.json({ error: 'Service temporarily unavailable' }, 503);
  const bind = { userId: auth.user.id, operation: 'add_factor' as const, authEpoch: epochs.authEpoch, mfaEpoch: epochs.mfaEpoch, sid: auth.token.sid };
  const ok = grantId
    ? (opts.consume ? await consumeStepUpGrant(grantId, bind) : await validateStepUpGrant(grantId, bind))
    : false;
  if (!ok) return c.json({ error: 'existing_factor_step_up_required', stepUpUrl: '/auth/mfa/step-up' }, 403);
  return null;
}
```

In `passkeys.ts`, extend `registerOptionsSchema` + `registerVerifySchema` with `stepUpGrantId: z.string().optional()`. In `/passkeys/register/options` (`:114`, after the password step-up) call the helper with `consume:false`; in `/passkeys/register/verify` (`:134`, before the factor write) call it with `consume:true`:

```ts
  const stepUpErr = await enforceExistingFactorStepUp(c, auth, c.req.valid('json').stepUpGrantId, { consume: false /* verify: true */ });
  if (stepUpErr) return stepUpErr;
```

Import `enforceExistingFactorStepUp` from `'./helpers'`.

- [ ] **Step 3d: Implement — gate the TOTP/SMS factor-addition endpoints (I1)**

Apply the SAME helper (with `consume:true`, since each is a terminal factor write) on the already-protected path of the three non-passkey factor-add endpoints. Add `stepUpGrantId: z.string().optional()` to each endpoint's schema (per Step 3b), keep the existing `requireCurrentPasswordStepUp`, and call the gate immediately BEFORE the factor write / `invalidateMfaAssuranceAfterFactorChange` (Task 7):

- **mfa.ts `/mfa/enable`** (`:467`) — after the password step-up (`:476`):
  ```ts
    const stepUpErr = await enforceExistingFactorStepUp(c, auth, c.req.valid('json').stepUpGrantId, { consume: true });
    if (stepUpErr) return stepUpErr;
  ```
- **mfa.ts setup-confirm** (Case 2 of `/mfa/verify`, `:286+`) — same call before the enable write. (`mfaVerifySchema` gains `stepUpGrantId` per Step 3b.)
- **phone.ts `/mfa/sms/enable`** (`:172`) — after its password step-up (`:180`), same call. Import `enforceExistingFactorStepUp` from `'./helpers'`.

No-factor accounts (`userIsMfaProtected === false`) pass through with password-only, so initial TOTP/SMS enrollment is unchanged. Adding/replacing a factor on a protected account now requires password AND a fresh existing-factor grant on ALL surfaces.

- [ ] **Step 4: Run to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/mfaStepUpGrant.test.ts src/routes/auth.passkeys.test.ts src/routes/auth.test.ts src/routes/auth/phone.test.ts src/routes/auth/helpers.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/mfaStepUpGrant.ts apps/api/src/services/mfaStepUpGrant.test.ts apps/api/src/routes/auth/mfa.ts apps/api/src/routes/auth/schemas.ts apps/api/src/routes/auth/passkeys.ts apps/api/src/routes/auth/phone.ts apps/api/src/routes/auth/helpers.ts apps/api/src/routes/auth.passkeys.test.ts apps/api/src/routes/auth.test.ts apps/api/src/routes/auth/phone.test.ts
git commit -m "feat(auth): existing-factor step-up grant for adding any factor (SR2-20)"
```

---

### Task 9: Integration tests + verification gate + open PR

**Files:**
- Create: `apps/api/src/__tests__/integration/mfaAssurance.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/recoveryCode.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/pendingMfaEpoch.integration.test.ts`

**Interfaces:**
- Consumes: everything above; the integration harness (`__tests__/integration/db-utils.ts`) and real Postgres on `:5433`.

- [ ] **Step 1: Write the failing tests**

`mfaAssurance.integration.test.ts`:
- Seed a user (factor + a refresh family). Call `invalidateMfaAssuranceAfterFactorChange(userId, 'test', mutate)` where `mutate` sets a factor field → assert `mfa_epoch` incremented by 1, the family `revoked_at` set, AND the factor field written — all committed together.
- Rollback: `mutate` throws → assert `mfa_epoch` UNCHANGED, family NOT revoked, factor field NOT written (atomicity).

`recoveryCode.integration.test.ts`:
- **Identical-code single-winner:** seed a user with 3 recovery-code hashes + two independent valid pending records (or reuse one per request as the harness allows). Fire TWO concurrent `/mfa/verify method:'recovery'` with the SAME valid code → assert exactly ONE returns 200 and the other 401, and the persisted array has exactly 2 hashes remaining (no double-spend).
- **Distinct-code no-resurrection (C1 regression):** seed a user with 3 recovery-code hashes [hA, hB, hC]. Fire TWO concurrent `/mfa/verify method:'recovery'` with DIFFERENT valid codes (one hashing to hA, the other to hB), each with its own valid pending record. Assert BOTH return 200 AND the persisted array is exactly `[hC]` (length N-2) — proving the relative jsonb `-` delete composed without either request resurrecting the other's removed hash (which a stale read-modify-write would have caused).

`pendingMfaEpoch.integration.test.ts`:
- Seed a user + write a pending record with `mfaEpoch=N`. Advance `mfa_epoch` to `N+1` via a committed `invalidateMfaAssuranceAfterFactorChange`. Assert `/mfa/verify` with that pending token returns 401 `Invalid or expired MFA session` and mints no tokens.

Follow existing `*.integration.test.ts` for app-bootstrap + `createSeededTenant`-style seeding from `db-utils.ts`.

- [ ] **Step 2: Run to verify they fail (then pass)**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/mfaAssurance.integration.test.ts src/__tests__/integration/recoveryCode.integration.test.ts src/__tests__/integration/pendingMfaEpoch.integration.test.ts
```
Expected: with Tasks 1-8 implemented, PASS. Observe at least one assertion fail when a piece is briefly reverted (TDD discipline). Requires the integration Postgres on `:5433` (single-fork; the harness runs `autoMigrate` on it automatically).

- [ ] **Step 3: Commit the integration tests**

```bash
git add apps/api/src/__tests__/integration/mfaAssurance.integration.test.ts apps/api/src/__tests__/integration/recoveryCode.integration.test.ts apps/api/src/__tests__/integration/pendingMfaEpoch.integration.test.ts
git commit -m "test(auth): integration coverage for MFA assurance, recovery single-winner, pending epoch"
```

- [ ] **Step 4: Full verification gate**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm typecheck && pnpm build
```
Expected: no type errors; build succeeds (Type Check includes the new test files).

Focused serial unit/route suites (API suite is parallel-flaky — name the exact touched files):
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run \
  src/services/mfaPolicy.test.ts \
  src/services/mfaAssurance.test.ts \
  src/services/mfaStepUpGrant.test.ts \
  src/routes/auth/helpers.test.ts \
  src/routes/auth/schemas.test.ts \
  src/routes/auth/login.test.ts \
  src/routes/auth/phone.test.ts \
  src/routes/auth.test.ts \
  src/routes/auth.passkeys.test.ts \
  src/routes/orgs.test.ts \
  src/middleware/auth.test.ts
```
Expected: PASS.

Migration drift (no migration added — must still be clean):
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && pnpm db:check-drift
```
Expected: no drift.

RLS + integration:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run --config vitest.config.rls.ts && \
  pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/mfaAssurance.integration.test.ts src/__tests__/integration/recoveryCode.integration.test.ts src/__tests__/integration/pendingMfaEpoch.integration.test.ts
```
Expected: PASS. RLS coverage unchanged (no new tables).

- [ ] **Step 5: Open the PR**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
git push -u origin core-auth-2-mfa-policy
gh pr create --base core-auth-1-lifecycle-foundation --title "feat(auth): MFA policy and assurance (SR2-05,06,07,09,19,20,24)" --body "$(cat <<'EOF'
Implements PR 2 of the core-authentication hardening design (docs/superpowers/specs/security-auth/2026-07-11-core-authentication-hardening-design.md). Stacks on PR #2378 (core-auth-1-lifecycle-foundation).

## What
- **SR2-05** One effective-MFA-policy resolver (`services/mfaPolicy.ts`): role force_mfa + org/partner requireMfa (through `getEffectiveOrgSettings`, partner-inherited) + canonical `security.allowedMethods`; strictest-wins, passkey always allowed. Middleware enrollment gate + login now use it. `allowedMfaMethods` is accepted only as an input alias, normalized into `allowedMethods`, never stored. The formerly inert SMS allowlist now enforces. The `MFA_FORCE_FOR_PARTNER_ADMIN` kill switch suppresses only role-driven forcing; org/partner `requireMfa` is enforced regardless.
- **SR2-05** Login no longer mints vacuous `mfa=true` for a policy-required unenrolled user — it returns a forced-enrollment signal (`mfa=false`).
- **SR2-06** Pending MFA records carry auth/mfa epochs, status expectation, allowed methods, and expiry; every completion path (TOTP/SMS/passkey) reloads the live user + policy, compares, and atomically consumes before minting.
- **SR2-24** TOTP setup confirmation and `/mfa/enable` use the consuming verifier — the accepted time step cannot be replayed at login.
- **SR2-09** Recovery-code login: schema accepts `XXXX-XXXX`, one matching hash is atomically removed (single winner under concurrency), tokens minted only after both records consume; audited without code material.
- **SR2-07 / SR2-19** `services/mfaAssurance.ts` invalidates assurance after every factor add/remove/replace/rotate: one transaction advances `mfa_epoch` + revokes all refresh families, then post-commit runs Redis/OAuth cleanup + remote-session teardown.
- **SR2-20** Adding ANY factor (TOTP/SMS/passkey) to an already-protected account requires a fresh existing-factor step-up grant (short-lived, single-use, bound to user/operation/epochs/session) in addition to current password. The existing-factor proof accepts a TOTP/SMS code OR a passkey assertion, so a passkey-only user is never locked out. Initial enrollment (no factor) stays password-only. Also routes `/mfa/disable` + the passkey last-factor guard through the resolver so a partner-set requireMfa blocks them.

## Deliberate global sign-out on factor change
Any factor add/remove/replace/recovery-rotation advances `mfa_epoch` and revokes all refresh families — the acting user (and their other sessions) must re-authenticate with the new configuration. Remote sessions are torn down after commit; teardown failure is reported as partial operational failure but never restores token validity.

## No migration
Epoch columns ship in PR 1; `mfa_recovery_codes` already exists. No schema change, no RLS allowlist change.

## Reviewer note
Overseer decision worth confirming: the `MFA_FORCE_FOR_PARTNER_ADMIN` kill switch was deliberately NARROWED to gate only the role-force component (`required = (roleForceMfa && !killSwitchOff) || settingsRequireMfa`). Turning it off no longer disables org/partner-configured `requireMfa` compliance — that was judged a latent foot-gun for a hardening PR. If ops still need a total MFA-enforcement escape hatch, that must be a separate, explicitly-named flag.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR opens against `core-auth-1-lifecycle-foundation`.

---

## Self-Review

**Spec coverage (PR 2 scope):**
| Finding | Task |
|---|---|
| SR2-05 policy resolver (role + org/partner requireMfa via effectiveSettings + allowedMethods) | Task 1 |
| SR2-05 canonical allowedMethods / alias normalization / SMS enforcement | Task 2 |
| SR2-05 enrollment enforcement + no vacuous `mfa=true` (exempt-path short-circuit BEFORE resolver) | Task 3 |
| SR2-05 factor-op surface: disable-block + last-factor guard via resolver (partner-inherited) | Task 7 (Step 3c) |
| SR2-06 epoch/status/method-bound pending MFA, reload+compare+consume | Task 4 |
| SR2-24 consuming TOTP setup verifier | Task 5 |
| SR2-09 recovery-code login, atomic RELATIVE single-use (no distinct-code resurrection) | Task 6 (+ Task 9 identical-code AND distinct-code proofs) |
| SR2-07 / SR2-19 factor-change epoch bump + family revoke + remote teardown | Task 7 (+ Task 9 atomicity proof) |
| SR2-20 existing-factor step-up grant for ALL factor additions (TOTP/SMS/passkey), proof accepts all factor types incl. passkey-only | Task 8 |
| Integration atomicity/concurrency + verification gate + PR | Task 9 |

**Decisions documented inline (no deferral to reader):**
- No migration (epochs + `mfa_recovery_codes` pre-exist) — stated in Global Constraints and PR body.
- Kill switch (`MFA_FORCE_FOR_PARTNER_ADMIN`) suppresses ONLY role-driven forcing; org/partner settings `requireMfa` is enforced regardless (`required = (roleForceMfa && !killSwitchOff) || settingsRequireMfa`). Overseer hardening decision overriding the earlier "global escape hatch" (Task 1).
- Scope resolution: system→none; org→effectiveSettings+org role; partner→partner settings+partner role (Task 1).
- Settings-read errors fail OPEN for policy AND emit bounded telemetry via `captureException` (imported from `./sentry`, matching authLifecycle.ts); single-use consumption fails CLOSED (Tasks 1, 4, 6, 8).
- allowedMethods: passkey always true, totp/sms gated by effective settings (Task 1).
- `/phone/confirm` invalidates only on active-SMS-factor replacement, not initial enrollment (Task 7).
- Pending-MFA payload + step-up grant TS shapes fixed in the Interfaces blocks (Tasks 4, 8).
- Audit `action`/`result` strings: `auth.mfa.enrollment.required`/denied (existing), `auth.mfa.recovery_code.used`/success, `auth.mfa.stepup.granted`|`.failed`, `mfa_pending_invalidated`|`mfa_method_not_allowed`|`mfa_recovery_code_invalid` failure reasons — all details carry counts/reasons only, never code material (Tasks 3, 4, 6, 8).

**Placeholder scan:** every code step contains concrete code. Test steps that say "follow the file's existing mock shape" name the exact file + the exact assertions required — mandatory because the Drizzle/Redis mock chain must mirror the specific source chain (breeze-testing rule) and cannot be authored blind. No TBD/TODO.

**Type consistency across tasks:** `EffectiveMfaPolicy`/`MfaPolicyInput`/`MfaAllowedMethods` (Task 1) consumed identically in Tasks 2, 3, 4, 7's callers. `PendingMfaRecord`/`parsePendingMfa`/`evaluatePendingMfa` (Task 4) consumed in Tasks 4's mfa.ts + passkeys.ts. `Tx`/`advanceUserEpochs`/`revokeAllRefreshFamilies`/`runPostCommitCleanup`/`PostCommitCleanupResult` (PR 1) consumed by Task 7's `mfaAssurance.ts`; `terminateUserRemoteSessions`/`TEARDOWN_FAILED` (existing) consumed by Task 7. `FactorChangeResult` (Task 7) is the return type used at all seven factor handlers. `StepUpGrant`/`mintStepUpGrant`/`validateStepUpGrant`/`consumeStepUpGrant` (Task 8) consumed by the mfa.ts mint endpoint and the single `enforceExistingFactorStepUp`/`userIsMfaProtected` helper pair in `helpers.ts`, which ALL four factor-add surfaces call (passkey options `consume:false`; passkey verify + `/mfa/enable` + setup-confirm + `/mfa/sms/enable` `consume:true`) — one binding shape, no divergent copies. `mfaStepUpSchema` is a `z.discriminatedUnion('method', …)` (`totp`/`sms`→`code`, `passkey`→`credential`) consumed by the mint endpoint's `body.method` switch; `verifyStepUpPasskeyAssertion` (exported from the passkeys route, no import cycle) is the passkey branch. `getUserEpochs` (PR 1) returns `{ authEpoch, mfaEpoch }`, consumed as such in Tasks 4, 8. Note: `auditUserLoginFailure` is already imported in mfa.ts (M1 — do not re-import).
