# Breeze Authenticator — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the data model, RLS, risk→assurance resolver, and a non-blocking enforcement seam for risk-tiered step-up approvals — shipping dark, zero behavior change.

**Architecture:** Three new persistence pieces (`authenticator_devices`, `authenticator_policies`, plus PIN columns on `users` and factor-recording columns on `approval_requests` / `elevation_requests`), a pure `requiredAssurance(riskTier, overrides)` function in `@breeze/shared`, and a `resolveApprovalAssurance` service the two decide endpoints call to record *which factor / assurance level* decided each approval. Phase 1 resolves and records but **never blocks** — proof verification (Phase 2/3) and partner-policy enforcement (Phase 4) layer on later.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL (RLS), Vitest. Node pinned to v22.20.0.

**Spec:** `docs/superpowers/specs/security-auth/2026-06-14-breeze-authenticator-step-up-approvals-design.md` (§4 ladder, §6 data model, §9 guard, §15 phasing).

**Conventions for every command below:** prefix Node so pnpm/vitest use the pinned runtime:
```
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH
```
RLS/integration tests need a real local DB (`export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"`) and the gitignored `.env.test` symlink present (fresh worktrees miss it → RLS forge tests go vacuous on a BYPASSRLS conn; confirm `rolbypassrls=false` for the test role first).

---

## File structure

| File | Responsibility |
|---|---|
| `packages/shared/src/utils/assuranceLevel.ts` (create) | `RiskTier`, `AssuranceLevel`, `requiredAssurance()`, `elevationRiskTierToName()` — pure, no I/O |
| `packages/shared/src/utils/assuranceLevel.test.ts` (create) | Unit tests for the resolver |
| `packages/shared/src/utils/index.ts` (modify) | Re-export the new util |
| `apps/api/src/db/schema/authenticatorDevices.ts` (create) | `authenticator_devices` table + `authenticator_kind` enum |
| `apps/api/src/db/schema/authenticatorPolicies.ts` (create) | `authenticator_policies` table |
| `apps/api/src/db/schema/index.ts` (modify) | Barrel exports for the two new schema files |
| `apps/api/src/db/schema/users.ts` (modify) | Approver PIN columns |
| `apps/api/src/db/schema/approvals.ts` (modify) | `approval_factor` enum + factor-recording columns |
| `apps/api/src/db/schema/elevations.ts` (modify) | Factor-recording columns (reuse `approval_factor`) |
| `apps/api/migrations/2026-06-14-a-authenticator-foundation.sql` (create) | All DDL + RLS policies (idempotent) |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (modify) | Add both tables to the tenancy allowlists |
| `apps/api/src/__tests__/integration/authenticatorRls.integration.test.ts` (create) | Functional cross-tenant forge proof |
| `apps/api/src/services/authenticatorAssurance.ts` (create) | `resolveApprovalAssurance()` / `resolveElevationAssurance()` |
| `apps/api/src/services/authenticatorAssurance.test.ts` (create) | Unit tests for the resolver service |
| `apps/api/src/routes/approvals.ts` (modify) | Call resolver in `decideHandler`, record factor columns |
| `apps/api/src/routes/pam.ts` (modify) | Call resolver in `respond`, record factor columns |

---

## Task 1: Shared `requiredAssurance` resolver

**Files:**
- Create: `packages/shared/src/utils/assuranceLevel.ts`
- Test: `packages/shared/src/utils/assuranceLevel.test.ts`
- Modify: `packages/shared/src/utils/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/utils/assuranceLevel.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  requiredAssurance,
  elevationRiskTierToName,
  DEFAULT_ASSURANCE_FLOOR,
} from './assuranceLevel';

describe('requiredAssurance', () => {
  it('maps each tier to the Breeze default floor', () => {
    expect(requiredAssurance('low')).toBe(1);
    expect(requiredAssurance('medium')).toBe(2);
    expect(requiredAssurance('high')).toBe(3);
    expect(requiredAssurance('critical')).toBe(4);
  });

  it('lets a partner override RAISE a rung', () => {
    expect(requiredAssurance('low', { low: 3 })).toBe(3);
    expect(requiredAssurance('medium', { medium: 4 })).toBe(4);
  });

  it('ignores an override that would LOWER below the floor', () => {
    expect(requiredAssurance('high', { high: 1 })).toBe(3);
    expect(requiredAssurance('critical', { critical: 2 })).toBe(4);
  });

  it('ignores a null/empty override map', () => {
    expect(requiredAssurance('medium', null)).toBe(2);
    expect(requiredAssurance('medium', {})).toBe(2);
  });

  it('exposes the default floor for reuse', () => {
    expect(DEFAULT_ASSURANCE_FLOOR).toEqual({ low: 1, medium: 2, high: 3, critical: 4 });
  });
});

describe('elevationRiskTierToName', () => {
  it('maps the elevation smallint to the canonical tier name', () => {
    expect(elevationRiskTierToName(1)).toBe('low');
    expect(elevationRiskTierToName(2)).toBe('medium');
    expect(elevationRiskTierToName(3)).toBe('high');
    expect(elevationRiskTierToName(4)).toBe('critical');
  });

  it('defaults null/0/out-of-range to medium (never silently low)', () => {
    expect(elevationRiskTierToName(null)).toBe('medium');
    expect(elevationRiskTierToName(undefined)).toBe('medium');
    expect(elevationRiskTierToName(0)).toBe('medium');
    expect(elevationRiskTierToName(99)).toBe('medium');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/utils/assuranceLevel.test.ts`
Expected: FAIL — `Failed to resolve import "./assuranceLevel"`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/utils/assuranceLevel.ts`:

```ts
/** Canonical risk tier (matches the approval_requests.risk_tier enum). */
export type RiskTier = 'low' | 'medium' | 'high' | 'critical';

/** Verification strength demanded of a decision. */
export type AssuranceLevel = 1 | 2 | 3 | 4;

/** Breeze default floor: risk tier → minimum assurance level. */
export const DEFAULT_ASSURANCE_FLOOR: Record<RiskTier, AssuranceLevel> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Partner policy may only RAISE a rung above the Breeze floor, never lower it.
 * Keys are risk tiers; values are the minimum level the partner demands.
 */
export type AssuranceFloorOverrides = Partial<Record<RiskTier, AssuranceLevel>>;

/**
 * Resolve the required assurance level for an approval. A partner override is
 * honored only when it is STRICTLY HIGHER than the Breeze floor — an override
 * that would weaken the floor is ignored (fail-closed).
 */
export function requiredAssurance(
  riskTier: RiskTier,
  overrides?: AssuranceFloorOverrides | null,
): AssuranceLevel {
  const base = DEFAULT_ASSURANCE_FLOOR[riskTier];
  const override = overrides?.[riskTier];
  return override && override > base ? override : base;
}

/**
 * `elevation_requests.risk_tier` is a smallint (1..4) set by pamBridge, while
 * `approval_requests.risk_tier` is the enum low|medium|high|critical. Map the
 * numeric form to the canonical name. Null / 0 / out-of-range default to
 * 'medium' — a safe non-trivial floor, never silently 'low'.
 */
export function elevationRiskTierToName(n: number | null | undefined): RiskTier {
  switch (n) {
    case 1:
      return 'low';
    case 3:
      return 'high';
    case 4:
      return 'critical';
    case 2:
      return 'medium';
    default:
      return 'medium';
  }
}
```

- [ ] **Step 4: Export from the utils barrel**

Add to `packages/shared/src/utils/index.ts` (alongside the other `export *` lines):

```ts
export * from './assuranceLevel';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/utils/assuranceLevel.test.ts`
Expected: PASS (12 assertions across 2 describes).

- [ ] **Step 6: Typecheck shared (it has no build step)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/utils/assuranceLevel.ts packages/shared/src/utils/assuranceLevel.test.ts packages/shared/src/utils/index.ts
git commit -m "feat(shared): risk-tier → assurance-level resolver"
```

---

## Task 2: Schema — `authenticator_devices`

**Files:**
- Create: `apps/api/src/db/schema/authenticatorDevices.ts`
- Modify: `apps/api/src/db/schema/index.ts`

- [ ] **Step 1: Write the schema file**

Create `apps/api/src/db/schema/authenticatorDevices.ts` (mirrors `userPasskeys.ts` conventions):

```ts
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const authenticatorKindEnum = pgEnum('authenticator_kind', [
  'mobile_hw_key',
  'webauthn_platform',
]);

export type AuthenticatorTransport =
  | 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb';

export const authenticatorDevices = pgTable(
  'authenticator_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: authenticatorKindEnum('kind').notNull(),
    label: varchar('label', { length: 255 }),
    publicKey: text('public_key').notNull(),
    // WebAuthn credential id (web only); null for mobile_hw_key.
    credentialId: text('credential_id').unique(),
    // Anti-clone counter (web) / monotonic nonce counter (mobile).
    signCount: integer('sign_count').notNull().default(0),
    aaguid: varchar('aaguid', { length: 36 }),
    transports: jsonb('transports').$type<AuthenticatorTransport[]>(),
    // True = non-syncable hardware key (eligible for L4 critical).
    isPlatformBound: boolean('is_platform_bound').notNull(),
    // FK to mobile_devices added in the migration (kept loose here to avoid a
    // schema import cycle); null for webauthn_platform.
    mobileDeviceId: uuid('mobile_device_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledReason: text('disabled_reason'),
  },
  (t) => ({
    userIdx: index('authenticator_devices_user_id_idx').on(t.userId),
  }),
);

export type AuthenticatorDevice = typeof authenticatorDevices.$inferSelect;
export type NewAuthenticatorDevice = typeof authenticatorDevices.$inferInsert;
```

- [ ] **Step 2: Register in the schema barrel**

Add to `apps/api/src/db/schema/index.ts` (next to `export * from './userPasskeys';`):

```ts
export * from './authenticatorDevices';
```

- [ ] **Step 3: Typecheck**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no NEW errors (pre-existing errors in `agents.test.ts` / `apiKeyAuth.test.ts` are known — see CLAUDE.md memory).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/authenticatorDevices.ts apps/api/src/db/schema/index.ts
git commit -m "feat(db): authenticator_devices schema"
```

---

## Task 3: Schema — `authenticator_policies`

**Files:**
- Create: `apps/api/src/db/schema/authenticatorPolicies.ts`
- Modify: `apps/api/src/db/schema/index.ts`

- [ ] **Step 1: Write the schema file**

Create `apps/api/src/db/schema/authenticatorPolicies.ts`:

```ts
import { pgTable, uuid, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';
import type { AssuranceFloorOverrides } from '@breeze/shared';

/** One approval-security policy row per MSP (partner). Partner-axis (Shape 3). */
export const authenticatorPolicies = pgTable('authenticator_policies', {
  partnerId: uuid('partner_id')
    .primaryKey()
    .references(() => partners.id, { onDelete: 'cascade' }),
  // Raise-only overrides of the Breeze default floor. {} = use defaults.
  floorOverrides: jsonb('floor_overrides').$type<AssuranceFloorOverrides>().notNull().default({}),
  // When true (after enforceFrom), L2+ approvals require an enrolled device.
  requireEnrollment: boolean('require_enrollment').notNull().default(false),
  enforceFrom: timestamp('enforce_from', { withTimezone: true }),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type AuthenticatorPolicy = typeof authenticatorPolicies.$inferSelect;
export type NewAuthenticatorPolicy = typeof authenticatorPolicies.$inferInsert;
```

- [ ] **Step 2: Register in the schema barrel**

Add to `apps/api/src/db/schema/index.ts`:

```ts
export * from './authenticatorPolicies';
```

- [ ] **Step 3: Typecheck**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no NEW errors. (If `@breeze/shared`'s `AssuranceFloorOverrides` does not resolve, run `pnpm --filter @breeze/shared typecheck` first — shared has no build artifact, types resolve from source.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/authenticatorPolicies.ts apps/api/src/db/schema/index.ts
git commit -m "feat(db): authenticator_policies schema (partner-axis)"
```

---

## Task 4: Schema — PIN columns + factor-recording columns + `approval_factor` enum

**Files:**
- Modify: `apps/api/src/db/schema/users.ts`
- Modify: `apps/api/src/db/schema/approvals.ts`
- Modify: `apps/api/src/db/schema/elevations.ts`

- [ ] **Step 1: Add approver PIN columns to `users`**

In `apps/api/src/db/schema/users.ts`, add these columns inside the `users` table definition (next to the existing `mfaSecret` / `mfaRecoveryCodes` columns). Ensure `integer` is in the `drizzle-orm/pg-core` import on that file:

```ts
    approverPinHash: text('approver_pin_hash'),
    approverPinSetAt: timestamp('approver_pin_set_at', { withTimezone: true }),
    approverPinFailedCount: integer('approver_pin_failed_count').notNull().default(0),
    approverPinLockedUntil: timestamp('approver_pin_locked_until', { withTimezone: true }),
```

- [ ] **Step 2: Add `approval_factor` enum + factor columns to `approval_requests`**

In `apps/api/src/db/schema/approvals.ts`: add `smallint` to the `drizzle-orm/pg-core` import, then add the enum just below `approvalRiskTierEnum` (line ~11):

```ts
export const approvalFactorEnum = pgEnum('approval_factor', [
  'session_tap',
  'mobile_hw_key',
  'webauthn_platform',
]);
```

Add these columns inside the `approvalRequests` table (after `isRecursive`, before `createdAt`):

```ts
    /** Assurance level actually satisfied by the decision (1..4). */
    decidedAssuranceLevel: smallint('decided_assurance_level'),
    /** Factor actually used to decide. Phase 1: always 'session_tap'. */
    decidedVia: approvalFactorEnum('decided_via'),
    /** The authenticator device that signed the decision (null for session_tap). */
    authenticatorDeviceId: uuid('authenticator_device_id'),
    /** Whether the approver PIN was verified for this decision. */
    pinVerified: boolean('pin_verified').notNull().default(false),
```

- [ ] **Step 3: Add factor columns to `elevation_requests`**

In `apps/api/src/db/schema/elevations.ts`: import the shared enum at the top —

```ts
import { approvalFactorEnum } from './approvals';
```

(If this introduces a circular import — i.e. `approvals.ts` already imports from `elevations.ts` — instead move `approvalFactorEnum` into `authenticatorDevices.ts` and import it from there in BOTH files. Verify with: `grep -n "from './elevations'" apps/api/src/db/schema/approvals.ts` — no output means no cycle, proceed with the import above.)

Ensure `smallint`, `uuid`, `boolean` are imported in `elevations.ts`. Add these columns to `elevationRequests` (after `riskTier`, before `metadata`):

```ts
    decidedAssuranceLevel: smallint('decided_assurance_level'),
    decidedVia: approvalFactorEnum('decided_via'),
    authenticatorDeviceId: uuid('authenticator_device_id'),
    pinVerified: boolean('pin_verified').notNull().default(false),
```

- [ ] **Step 4: Typecheck**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no NEW errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/users.ts apps/api/src/db/schema/approvals.ts apps/api/src/db/schema/elevations.ts
git commit -m "feat(db): approver PIN + approval factor-recording columns"
```

---

## Task 5: Migration — tables, columns, enums, RLS

**Files:**
- Create: `apps/api/migrations/2026-06-14-a-authenticator-foundation.sql`

> Naming: date-prefixed with an `-a-` infix so it sorts deterministically and unambiguously. No inner `BEGIN;`/`COMMIT;` (autoMigrate wraps each file). Fully idempotent.

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-06-14-a-authenticator-foundation.sql`:

```sql
-- Breeze Authenticator — Phase 1 foundation.
-- Idempotent: enums via duplicate_object guard, tables/columns IF NOT EXISTS,
-- policies via pg_policies existence checks, FKs via pg_constraint checks.

-- 1. Enums -------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE authenticator_kind AS ENUM ('mobile_hw_key', 'webauthn_platform');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE approval_factor AS ENUM ('session_tap', 'mobile_hw_key', 'webauthn_platform');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. authenticator_devices (Shape 6 — user-id scoped) ------------------------
CREATE TABLE IF NOT EXISTS authenticator_devices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              authenticator_kind NOT NULL,
  label             varchar(255),
  public_key        text NOT NULL,
  credential_id     text UNIQUE,
  sign_count        integer NOT NULL DEFAULT 0,
  aaguid            varchar(36),
  transports        jsonb,
  is_platform_bound boolean NOT NULL,
  mobile_device_id  uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz,
  disabled_at       timestamptz,
  disabled_reason   text
);

CREATE INDEX IF NOT EXISTS authenticator_devices_user_id_idx
  ON authenticator_devices(user_id);

-- mobile_device_id FK (nullable, SET NULL on device unpair).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'authenticator_devices_mobile_device_id_fkey'
  ) THEN
    ALTER TABLE authenticator_devices
      ADD CONSTRAINT authenticator_devices_mobile_device_id_fkey
      FOREIGN KEY (mobile_device_id) REFERENCES mobile_devices(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE authenticator_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE authenticator_devices FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'authenticator_devices'
      AND policyname = 'authenticator_devices_user_scope'
  ) THEN
    CREATE POLICY authenticator_devices_user_scope ON authenticator_devices
      FOR ALL
      TO breeze_app
      USING     (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system')
      WITH CHECK (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system');
  END IF;
END $$;

-- 3. authenticator_policies (Shape 3 — partner-axis) -------------------------
CREATE TABLE IF NOT EXISTS authenticator_policies (
  partner_id          uuid PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE,
  floor_overrides     jsonb NOT NULL DEFAULT '{}'::jsonb,
  require_enrollment  boolean NOT NULL DEFAULT false,
  enforce_from        timestamptz,
  updated_by_user_id  uuid REFERENCES users(id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE authenticator_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE authenticator_policies FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'authenticator_policies'
      AND policyname = 'authenticator_policies_partner_access'
  ) THEN
    CREATE POLICY authenticator_policies_partner_access ON authenticator_policies
      FOR ALL
      TO breeze_app
      USING     (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;

-- 4. Approver PIN columns on users ------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS approver_pin_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approver_pin_set_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approver_pin_failed_count integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approver_pin_locked_until timestamptz;

-- 5. Factor-recording columns on approval_requests + elevation_requests ------
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS decided_assurance_level smallint;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS decided_via approval_factor;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS authenticator_device_id uuid;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS pin_verified boolean NOT NULL DEFAULT false;

ALTER TABLE elevation_requests ADD COLUMN IF NOT EXISTS decided_assurance_level smallint;
ALTER TABLE elevation_requests ADD COLUMN IF NOT EXISTS decided_via approval_factor;
ALTER TABLE elevation_requests ADD COLUMN IF NOT EXISTS authenticator_device_id uuid;
ALTER TABLE elevation_requests ADD COLUMN IF NOT EXISTS pin_verified boolean NOT NULL DEFAULT false;

-- authenticator_device_id FKs (SET NULL so a revoked device leaves audit rows).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_requests_authenticator_device_id_fkey') THEN
    ALTER TABLE approval_requests
      ADD CONSTRAINT approval_requests_authenticator_device_id_fkey
      FOREIGN KEY (authenticator_device_id) REFERENCES authenticator_devices(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'elevation_requests_authenticator_device_id_fkey') THEN
    ALTER TABLE elevation_requests
      ADD CONSTRAINT elevation_requests_authenticator_device_id_fkey
      FOREIGN KEY (authenticator_device_id) REFERENCES authenticator_devices(id) ON DELETE SET NULL;
  END IF;
END $$;
```

- [ ] **Step 2: Apply the migration to the local DB**

The migration runner is `autoMigrate` (runs on API boot; `db:migrate` is a no-op export — see memory). Apply by booting the API once, or run the migrate entrypoint directly:

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsx src/db/autoMigrate.ts 2>/dev/null \
  || echo "no standalone entry — boot the API once (pnpm --filter @breeze/api dev) to apply, then Ctrl-C"
```
Expected: the new migration filename logged as applied; re-running is a clean no-op (idempotent).

- [ ] **Step 3: Verify no schema drift**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift`
Expected: "No schema drift" (Drizzle schema matches the migrated DB).

- [ ] **Step 4: Verify RLS rejects a cross-tenant insert as `breeze_app` (manual smoke)**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c \
  "INSERT INTO authenticator_devices (user_id, kind, public_key, is_platform_bound) \
   VALUES (gen_random_uuid(), 'mobile_hw_key', 'x', true);"
```
Expected: `ERROR: new row violates row-level security policy for table "authenticator_devices"` (no user context set → `breeze_current_user_id()` is null).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-14-a-authenticator-foundation.sql
git commit -m "feat(db): authenticator foundation migration + RLS"
```

---

## Task 6: RLS coverage allowlists (contract test)

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

- [ ] **Step 1: Add `authenticator_devices` to `USER_ID_SCOPED_TABLES`**

In the `USER_ID_SCOPED_TABLES` set (ends ~line 231, after `'user_passkeys'`), add:

```ts
  // authenticator_devices: Breeze Authenticator approver device keys, scoped to
  // the owning user via breeze_current_user_id(), with an
  // OR breeze_current_scope() = 'system' branch (Shape 6). Mirrors user_passkeys.
  'authenticator_devices',
```

- [ ] **Step 2: Add `authenticator_policies` to `PARTNER_TENANT_TABLES`**

In the `PARTNER_TENANT_TABLES` map (ends ~line 116), add:

```ts
  // authenticator_policies: per-MSP approval-security policy (Shape 3). One row
  // per partner; policy gates on breeze_has_partner_access(partner_id) with a
  // system-scope OR branch. Functional forge: authenticatorRls.integration.test.ts.
  ['authenticator_policies', 'partner_id'],
```

- [ ] **Step 3: Run the contract test**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run \
  --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: PASS — both new tables are recognized in their tenancy axis; the "tables with RLS but missing a policy" and "untracked tenant tables" assertions stay green. (If it reports `authenticator_devices` as an untracked tenant table, the migration in Task 5 was not applied to this DB — re-apply.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(rls): track authenticator tables in tenancy allowlists"
```

---

## Task 7: Functional cross-tenant forge test

**Files:**
- Create: `apps/api/src/__tests__/integration/authenticatorRls.integration.test.ts`

> The coverage contract test only checks a policy *exists* and references the right helper — it does NOT catch a wrong axis or a vacuous policy (memory: dual-axis & FK-child blindspots). This functional test forges a cross-tenant read/write as `breeze_app` and asserts RLS blocks it. Re-seed fixtures per test (setup `beforeEach` TRUNCATE CASCADE wipes module-scope fixtures → later cases go vacuous — memory: memoized-fixture trap).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/__tests__/integration/authenticatorRls.integration.test.ts`. Model it on the existing forge tests (open one for the exact helper imports/DB-context utilities used in this repo, e.g. `customFieldsRls.integration.test.ts` or `emailInboundRls.integration.test.ts`, and reuse their `withDbAccessContext` / seed helpers):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { authenticatorDevices, authenticatorPolicies, users, partners } from '../../db/schema';
import { sql } from 'drizzle-orm';
// NOTE: import the SAME seed/fixture + context helpers the sibling forge tests use.

describe('authenticator RLS (functional forge)', () => {
  // Re-seed per test — do NOT hoist fixtures to module scope (gets wiped).
  let tenantA: { partnerId: string; userId: string };
  let tenantB: { partnerId: string; userId: string };

  beforeEach(async () => {
    // Create two isolated partners + a user each, under system scope.
    tenantA = await seedPartnerWithUser('A'); // implement via the sibling test's helper
    tenantB = await seedPartnerWithUser('B');
  });

  it('authenticator_devices: tenant A cannot read tenant B device rows', async () => {
    // Seed a device for B under system scope.
    await withSystemDbAccessContext(async (tx) => {
      await tx.insert(authenticatorDevices).values({
        userId: tenantB.userId, kind: 'mobile_hw_key', publicKey: 'B-key', isPlatformBound: true,
      });
    });
    // As A, select all authenticator_devices — RLS must hide B's row.
    const rows = await withDbAccessContext(
      { userId: tenantA.userId, partnerId: tenantA.partnerId, orgId: null },
      async (tx) => tx.select().from(authenticatorDevices),
    );
    expect(rows.find((r) => r.userId === tenantB.userId)).toBeUndefined();
  });

  it('authenticator_devices: tenant A cannot forge a row for tenant B user', async () => {
    await expect(
      withDbAccessContext(
        { userId: tenantA.userId, partnerId: tenantA.partnerId, orgId: null },
        async (tx) => tx.insert(authenticatorDevices).values({
          userId: tenantB.userId, kind: 'mobile_hw_key', publicKey: 'forged', isPlatformBound: true,
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('authenticator_policies: tenant A cannot read tenant B policy', async () => {
    await withSystemDbAccessContext(async (tx) => {
      await tx.insert(authenticatorPolicies).values({ partnerId: tenantB.partnerId, requireEnrollment: true });
    });
    const rows = await withDbAccessContext(
      { userId: tenantA.userId, partnerId: tenantA.partnerId, orgId: null },
      async (tx) => tx.select().from(authenticatorPolicies),
    );
    expect(rows.find((r) => r.partnerId === tenantB.partnerId)).toBeUndefined();
  });

  it('authenticator_policies: tenant A cannot forge a policy for tenant B', async () => {
    await expect(
      withDbAccessContext(
        { userId: tenantA.userId, partnerId: tenantA.partnerId, orgId: null },
        async (tx) => tx.insert(authenticatorPolicies).values({ partnerId: tenantB.partnerId, requireEnrollment: true }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
```

> Replace `seedPartnerWithUser` and the exact `withDbAccessContext` signature with the helpers the sibling forge test in this repo actually exports — do not invent a new fixture layer. Confirm the test role has `rolbypassrls = false` first:
> `docker exec -it breeze-postgres psql -U postgres -d breeze -c "SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname='breeze_app';"` → must be `f`.

- [ ] **Step 2: Run it; confirm it PASSES against the real policies**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run \
  --config vitest.integration.config.ts src/__tests__/integration/authenticatorRls.integration.test.ts
```
Expected: PASS (4 cases). **Sanity-check it's not vacuous:** temporarily comment out the `authenticator_devices_user_scope` policy line in the migration, re-apply, re-run → the read/forge cases must FAIL. Restore the policy.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/authenticatorRls.integration.test.ts
git commit -m "test(rls): functional cross-tenant forge for authenticator tables"
```

---

## Task 8: `resolveApprovalAssurance` service

**Files:**
- Create: `apps/api/src/services/authenticatorAssurance.ts`
- Test: `apps/api/src/services/authenticatorAssurance.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/authenticatorAssurance.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveApprovalAssurance, resolveElevationAssurance } from './authenticatorAssurance';

describe('resolveApprovalAssurance (Phase 1: resolve-only, never blocks)', () => {
  it('reports the would-be required level scaled to risk tier', () => {
    expect(resolveApprovalAssurance('low').requiredLevel).toBe(1);
    expect(resolveApprovalAssurance('medium').requiredLevel).toBe(2);
    expect(resolveApprovalAssurance('high').requiredLevel).toBe(3);
    expect(resolveApprovalAssurance('critical').requiredLevel).toBe(4);
  });

  it('records every decision as a session tap at level 1 (no behavior change yet)', () => {
    for (const tier of ['low', 'medium', 'high', 'critical'] as const) {
      const d = resolveApprovalAssurance(tier);
      expect(d.decidedVia).toBe('session_tap');
      expect(d.decidedAssuranceLevel).toBe(1);
      expect(d.authenticatorDeviceId).toBeNull();
      expect(d.pinVerified).toBe(false);
    }
  });
});

describe('resolveElevationAssurance', () => {
  it('maps the elevation smallint tier through to the resolver', () => {
    expect(resolveElevationAssurance(4).requiredLevel).toBe(4);
    expect(resolveElevationAssurance(1).requiredLevel).toBe(1);
    expect(resolveElevationAssurance(null).requiredLevel).toBe(2); // null → medium
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/authenticatorAssurance.test.ts`
Expected: FAIL — cannot find `./authenticatorAssurance`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/authenticatorAssurance.ts`:

```ts
import {
  requiredAssurance,
  elevationRiskTierToName,
  type RiskTier,
  type AssuranceLevel,
} from '@breeze/shared';

export interface AssuranceDecision {
  /** Level the policy would require for this approval (telemetry / future gate). */
  requiredLevel: AssuranceLevel;
  /** Level actually satisfied by the recorded decision. */
  decidedAssuranceLevel: AssuranceLevel;
  /** Factor actually used. Phase 1 is always a session tap. */
  decidedVia: 'session_tap' | 'mobile_hw_key' | 'webauthn_platform';
  authenticatorDeviceId: string | null;
  pinVerified: boolean;
}

/**
 * Phase 1 (foundation): resolve the would-be required assurance and return the
 * factor-recording fields for the decide path to persist. This NEVER blocks —
 * proof verification (Phase 2/3) and partner-policy enforcement (Phase 4) layer
 * on later. Today every decision is a logged-in session tap, so the recorded
 * level is 1 regardless of the required level.
 *
 * NOTE: partner-policy floor overrides are intentionally NOT consulted yet
 * (the table exists for Phase 4). `requiredAssurance` is called with defaults.
 */
export function resolveApprovalAssurance(riskTier: RiskTier): AssuranceDecision {
  return {
    requiredLevel: requiredAssurance(riskTier),
    decidedAssuranceLevel: 1,
    decidedVia: 'session_tap',
    authenticatorDeviceId: null,
    pinVerified: false,
  };
}

/** Convenience for the PAM path, whose risk_tier is a smallint (1..4). */
export function resolveElevationAssurance(riskTierNum: number | null): AssuranceDecision {
  return resolveApprovalAssurance(elevationRiskTierToName(riskTierNum));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/authenticatorAssurance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/authenticatorAssurance.ts apps/api/src/services/authenticatorAssurance.test.ts
git commit -m "feat(api): resolveApprovalAssurance service (resolve-only, Phase 1)"
```

---

## Task 9: Wire the resolver into the approvals decide path

**Files:**
- Modify: `apps/api/src/routes/approvals.ts` (the `decideHandler`, ~line 258)

> Restructure `decideHandler` to pre-fetch the row (so the risk tier is known before the CAS), resolve assurance, and persist the factor columns in the CAS update. 404/409/410 semantics are preserved. This is the seam Phase 2 reuses to *block* on missing proof.

- [ ] **Step 1: Write the failing test**

Add to (or create) `apps/api/src/routes/approvals.test.ts` a unit test asserting a decided approval persists the factor columns. Mirror the Drizzle-mock pattern the existing approvals tests use (see `breeze-testing` skill). The key assertion:

```ts
it('records session_tap factor columns on approve', async () => {
  // ... arrange a pending approval_requests row (riskTier 'high') via the mock ...
  const res = await app.request(`/api/v1/approvals/${id}/approve`, { method: 'POST', headers: authHeaders });
  expect(res.status).toBe(200);
  // The UPDATE .set(...) must include these:
  expect(capturedUpdateSet).toMatchObject({
    status: 'approved',
    decidedVia: 'session_tap',
    decidedAssuranceLevel: 1,
    authenticatorDeviceId: null,
    pinVerified: false,
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/approvals.test.ts`
Expected: FAIL — the update set has no `decidedVia`.

- [ ] **Step 3: Add the import**

At the top of `apps/api/src/routes/approvals.ts`, add:

```ts
import { resolveApprovalAssurance } from '../services/authenticatorAssurance';
import type { RiskTier } from '@breeze/shared';
```

- [ ] **Step 4: Replace `decideHandler` body**

Replace the `decideHandler` function (currently lines ~258–319) with:

```ts
async function decideHandler(
  c: import('hono').Context,
  status: 'approved' | 'denied',
  reason?: string
) {
  const userId = c.get('auth').user.id;
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Bad request' }, 400);

  // Pre-fetch so we can resolve the required assurance from the row's risk tier
  // before deciding. Phase 1: resolve only RECORDS the factor; it never blocks.
  const [existing] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId)));

  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.status !== 'pending') {
    return c.json({ error: `Already ${existing.status}`, finalStatus: existing.status }, 409);
  }
  if (existing.expiresAt <= new Date()) {
    return c.json({ error: 'Expired', finalStatus: 'expired' }, 410);
  }

  const assurance = resolveApprovalAssurance(existing.riskTier as RiskTier);

  const result = await db
    .update(approvalRequests)
    .set({
      status,
      decidedAt: new Date(),
      decisionReason: reason ?? null,
      decidedAssuranceLevel: assurance.decidedAssuranceLevel,
      decidedVia: assurance.decidedVia,
      authenticatorDeviceId: assurance.authenticatorDeviceId,
      pinVerified: assurance.pinVerified,
    })
    .where(
      and(
        eq(approvalRequests.id, id),
        eq(approvalRequests.userId, userId),
        eq(approvalRequests.status, 'pending'),
        gt(approvalRequests.expiresAt, new Date()),
      )
    )
    .returning();

  if (result.length === 0) {
    // Lost a concurrent decide/expiry race between the pre-fetch and the CAS.
    return c.json({ error: 'Already decided', finalStatus: 'expired' }, 409);
  }

  const [updated] = result;

  // Unchanged: mirror an AI-SDK-sourced approval back onto ai_tool_executions.
  if (updated?.executionId) {
    const aiStatus = status === 'approved' ? 'approved' : 'rejected';
    try {
      await db
        .update(aiToolExecutions)
        .set({ status: aiStatus, approvedBy: userId, approvedAt: new Date() })
        .where(eq(aiToolExecutions.id, updated.executionId));
    } catch (err) {
      console.error('[approvals] Failed to mirror status to ai_tool_executions:', err);
    }
  }

  return c.json({ approval: serialize(updated!) });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/approvals.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/approvals.ts apps/api/src/routes/approvals.test.ts
git commit -m "feat(api): record assurance factor on approval decide"
```

---

## Task 10: Wire the resolver into the PAM `respond` path

**Files:**
- Modify: `apps/api/src/routes/pam.ts` (the `/elevation-requests/:id/respond` handler, ~line 291)

- [ ] **Step 1: Write the failing test**

In the PAM route test file (`apps/api/src/routes/pam.test.ts` — create if absent, mirroring the existing route-test mock setup), assert the elevation decide persists factor columns:

```ts
it('records session_tap factor columns on elevation approve', async () => {
  // arrange a pending elevation_requests row (risk_tier = 3) via the mock
  const res = await app.request(`/pam/elevation-requests/${id}/respond`, {
    method: 'POST', headers: authHeaders, body: JSON.stringify({ decision: 'approve' }),
  });
  expect(res.status).toBe(200);
  expect(capturedElevationUpdateSet).toMatchObject({
    status: 'approved',
    decidedVia: 'session_tap',
    decidedAssuranceLevel: 1,
    pinVerified: false,
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/pam.test.ts`
Expected: FAIL — the elevation update set has no `decidedVia`.

- [ ] **Step 3: Add the import**

At the top of `apps/api/src/routes/pam.ts`:

```ts
import { resolveElevationAssurance } from '../services/authenticatorAssurance';
```

- [ ] **Step 4: Select `riskTier`, resolve, and record in both branches**

In the `respond` transaction (~lines 320–361):

(a) Add `riskTier` to the row select (after `executionId:`):

```ts
            riskTier: elevationRequests.riskTier,
```

(b) Immediately after the `forbidden`/`not_found` guards and before the CAS `update`, add:

```ts
        const assurance = resolveElevationAssurance(row.riskTier);
```

(c) Add the four factor fields to BOTH branches of the `.set(...)`. Approve branch:

```ts
              ? {
                  status: 'approved',
                  approvedByUserId: auth.user.id,
                  approvedAt: now,
                  expiresAt: new Date(now.getTime() + durationMinutes * 60_000),
                  updatedAt: now,
                  decidedAssuranceLevel: assurance.decidedAssuranceLevel,
                  decidedVia: assurance.decidedVia,
                  authenticatorDeviceId: assurance.authenticatorDeviceId,
                  pinVerified: assurance.pinVerified,
                }
```

Deny branch:

```ts
              : {
                  status: 'denied',
                  deniedByUserId: auth.user.id,
                  denialReason: body.reason ?? null,
                  updatedAt: now,
                  decidedAssuranceLevel: assurance.decidedAssuranceLevel,
                  decidedVia: assurance.decidedVia,
                  authenticatorDeviceId: assurance.authenticatorDeviceId,
                  pinVerified: assurance.pinVerified,
                }
```

(d) Add `assurance_level` + `factor` to the `elevationAudit` `details` JSONB:

```ts
          details: {
            reason: body.reason,
            ...(approve ? { duration_minutes: durationMinutes } : {}),
            assurance_level: assurance.decidedAssuranceLevel,
            factor: assurance.decidedVia,
          },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/pam.test.ts`
Expected: PASS.

- [ ] **Step 6: Full typecheck + touched-file test sweep**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run \
  src/services/authenticatorAssurance.test.ts src/routes/approvals.test.ts src/routes/pam.test.ts
```
Expected: typecheck clean (no NEW errors); all three suites green. (Run affected files single-fork — the full `vitest run` is flaky on a pristine tree; trust CI for the whole suite — memory.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/pam.ts apps/api/src/routes/pam.test.ts
git commit -m "feat(api): record assurance factor on PAM elevation respond"
```

---

## Self-review (completed during planning)

- **Spec coverage (§ in spec → task):** `authenticator_devices` §6.1 → T2/T5; users PIN §6.2 → T4/T5; `authenticator_policies` §6.3 → T3/T5; factor columns §6.4 → T4/T5; `requiredAssurance` §3/§9 → T1; resolver service §9 → T8; decide-path wiring §9 → T9/T10; RLS Shapes 6/3 + allowlists + contract test §6/§14 → T5/T6/T7; "ships dark / #1254 unblocked" §15 Phase 1 → resolver is resolve-only (T8) + L1 default. **Deferred to later phases (correctly out of scope here):** challenge/sign/verify (§7/§8), PIN argon2 verify + lockout (§6.2 behavior), partner-policy enforcement + grace window (§10), recovery/lifecycle (§11), admin UI (§10), mobile/browser registration (§7). These are Phases 2–4 and get their own plans.
- **Placeholder scan:** the only intentional "fill from the sibling" markers are in T7 (forge fixture helpers) and T9/T10 (Drizzle-mock capture), which explicitly point at concrete existing tests to copy — not vague TODOs.
- **Type consistency:** `RiskTier`/`AssuranceLevel`/`AssuranceFloorOverrides` defined in T1 and consumed unchanged in T3/T8; `AssuranceDecision` fields (`decidedAssuranceLevel`/`decidedVia`/`authenticatorDeviceId`/`pinVerified`) match the columns added in T4 and the `.set(...)` keys in T9/T10; `approvalFactorEnum` values (`session_tap`/`mobile_hw_key`/`webauthn_platform`) match `decidedVia`'s union in T8.

---

## What Phase 1 deliberately does NOT do

No user-visible behavior changes. No enforcement, no challenge/signature, no PIN verification, no registration endpoints, no UI. Every approval still decides on session alone and is now *recorded* as `session_tap` / level 1. This is the dark foundation; Phases 2 (browser approver + verify), 3 (mobile authenticator + PIN), and 4 (critical hardening + partner policy enforcement) build on it and each get their own plan.
