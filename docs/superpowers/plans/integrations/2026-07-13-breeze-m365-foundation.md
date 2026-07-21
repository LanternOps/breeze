# Breeze M365 Control-Plane Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the code-owned permission profiles, canonical connection metadata, dual-axis tenant isolation, legacy-direct compatibility, and Azure Key Vault credential boundary required by the Breeze M365 control plane.

**Architecture:** Evolve the existing `m365_connections` table in place so it becomes the canonical metadata record while preserving existing direct-client-secret rows as an explicit `legacy-direct` migration state. Keep permission definitions in code, keep reusable credential material behind an executor-only provider interface, and enforce organization/user ownership in PostgreSQL RLS. This plan creates no MCP actions, consent callbacks, token acquisition, or executor jobs; those are separate plans built on these contracts.

**Tech Stack:** TypeScript 5.7, Hono service conventions, Drizzle ORM 0.45, PostgreSQL RLS, Vitest 4, Azure Identity 4.6, Azure Key Vault Secrets 4.9, pnpm workspaces.

## Global Constraints

- `m365_connections` is the sole canonical M365 metadata table; Delegant and C2C rows remain migration inputs, not competing tenant authorities.
- Postgres may retain `client_secret` only for rows explicitly marked `legacy-direct`; all new profile rows require a vault reference and prohibit a database secret.
- Exactly one owner axis is populated: `org_id` for customer profiles or `user_id` for `communications-delegated`.
- Tenant IDs are canonical Entra GUIDs; domains such as `contoso.onmicrosoft.com` are rejected.
- Permission profiles are code-owned and versioned. This plan creates profile version `1` only.
- Credential domains remain separate: communications, Graph read, Graph actions, and Exchange PowerShell.
- No Graph URL, HTTP method, raw PowerShell, token, private key, or refresh token is accepted by a route in this plan.
- The main Breeze API stores and returns credential references only. Only executor modules may import `CredentialProvider` implementations.
- RLS is enabled and forced, and functional tests run as `breeze_app` with `rolbypassrls=false`.
- Existing direct-M365 reads and mutations continue to use only `legacy-direct` rows until their typed executor replacement ships.
- Follow TDD for every task and commit each independently passing deliverable.

## Plan series boundary

This is plan 1 of the implementation series. The remaining independently testable plans are: consent and verification; immutable intents and durable approvals; read executors; mutation executors; Exchange PowerShell executor; consumer migration; and Delegant removal. None of those capabilities are partially implemented here.

## File map

| File | Responsibility |
|---|---|
| `apps/api/src/services/m365ControlPlane/profiles.ts` | Profile IDs, credential domains, manifests, and manifest lookup/reconciliation |
| `apps/api/src/services/m365ControlPlane/profiles.test.ts` | Contract tests for all four production profiles |
| `apps/api/src/db/schema/m365.ts` | Canonical Drizzle connection metadata model plus transitional legacy fields |
| `apps/api/migrations/2026-07-13-m365-control-plane-foundation.sql` | Idempotent schema evolution, constraints, indexes, and dual-axis RLS |
| `apps/api/src/db/schema/m365.test.ts` | Drizzle-to-database column and index contract |
| `apps/api/src/services/m365DirectGraph.ts` | Fail-closed compatibility access to `legacy-direct` only |
| `apps/api/src/routes/m365.ts` | Existing legacy connection route explicitly writes/reads `legacy-direct` only |
| `apps/api/src/routes/m365.test.ts` | Regression coverage for legacy filtering and secret suppression |
| `apps/api/src/__tests__/integration/m365ConnectionsRls.integration.test.ts` | Real-role organization/user-axis RLS forge tests |
| `apps/api/src/executors/m365/credentials/types.ts` | Executor-only credential material and provider interface |
| `apps/api/src/executors/m365/credentials/azureKeyVaultProvider.ts` | Azure Key Vault implementation with domain-checked references |
| `apps/api/src/executors/m365/credentials/azureKeyVaultProvider.test.ts` | Vault serialization, reference, mismatch, and deletion tests |
| `apps/api/package.json` / `pnpm-lock.yaml` | Azure SDK dependencies |

---

### Task 1: Code-owned M365 permission profiles

**Files:**
- Create: `apps/api/src/services/m365ControlPlane/profiles.ts`
- Create: `apps/api/src/services/m365ControlPlane/profiles.test.ts`

**Interfaces:**
- Produces: `M365ConnectionProfile`, `M365CredentialDomain`, `M365AuthMode`, `M365PermissionProfileManifest`, `M365_PERMISSION_PROFILES`, `getM365PermissionProfile()`, and `connectionNeedsConsentReconciliation()`.
- Consumes: no database or Microsoft SDK code.

- [ ] **Step 1: Write the failing profile contract tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  M365_PERMISSION_PROFILES,
  connectionNeedsConsentReconciliation,
  getM365PermissionProfile,
} from './profiles';

describe('M365 permission profiles', () => {
  it('defines the four production profiles with isolated credential domains', () => {
    expect(Object.keys(M365_PERMISSION_PROFILES).sort()).toEqual([
      'communications-delegated',
      'customer-exchange-powershell',
      'customer-graph-actions',
      'customer-graph-read',
    ]);
    expect(new Set(Object.values(M365_PERMISSION_PROFILES).map((p) => p.credentialDomain)).size).toBe(4);
  });

  it('keeps read and mutation Graph grants separate', () => {
    const read = getM365PermissionProfile('customer-graph-read');
    const actions = getM365PermissionProfile('customer-graph-actions');
    expect(read.applicationPermissions).toContain('User.Read.All');
    expect(read.applicationPermissions).not.toContain('User.ReadWrite.All');
    expect(actions.applicationPermissions).toContain('User.ReadWrite.All');
    expect(actions.applicationPermissions).not.toContain('User.Read.All');
  });

  it('uses delegated auth only for communications and app certificates elsewhere', () => {
    expect(getM365PermissionProfile('communications-delegated').authMode).toBe('delegated');
    for (const id of ['customer-graph-read', 'customer-graph-actions', 'customer-exchange-powershell'] as const) {
      expect(getM365PermissionProfile(id).authMode).toBe('application-certificate');
    }
  });

  it('requires reconciliation whenever stored manifest version differs', () => {
    expect(connectionNeedsConsentReconciliation('customer-graph-read', 1)).toBe(false);
    expect(connectionNeedsConsentReconciliation('customer-graph-read', 0)).toBe(true);
    expect(connectionNeedsConsentReconciliation('customer-graph-read', 2)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `pnpm --filter @breeze/api test:run -- src/services/m365ControlPlane/profiles.test.ts`

Expected: FAIL because `./profiles` does not exist.

- [ ] **Step 3: Implement the complete profile registry**

```ts
export const M365_CONNECTION_PROFILES = [
  'communications-delegated',
  'customer-graph-read',
  'customer-graph-actions',
  'customer-exchange-powershell',
] as const;

export type M365ConnectionProfile = (typeof M365_CONNECTION_PROFILES)[number];

export const M365_CREDENTIAL_DOMAINS = [
  'communications-delegated',
  'customer-graph-read',
  'customer-graph-actions',
  'customer-exchange-powershell',
] as const;

export type M365CredentialDomain = (typeof M365_CREDENTIAL_DOMAINS)[number];
export type M365AuthMode = 'delegated' | 'application-certificate';
export type M365ExecutorKind = 'communications' | 'graph-read' | 'graph-actions' | 'exchange-powershell';

export interface M365PermissionProfileManifest {
  readonly id: M365ConnectionProfile;
  readonly version: number;
  readonly ownerAxis: 'user' | 'organization';
  readonly authMode: M365AuthMode;
  readonly credentialDomain: M365CredentialDomain;
  readonly executor: M365ExecutorKind;
  readonly delegatedPermissions: readonly string[];
  readonly applicationPermissions: readonly string[];
}

export const M365_PERMISSION_PROFILES = {
  'communications-delegated': {
    id: 'communications-delegated',
    version: 1,
    ownerAxis: 'user',
    authMode: 'delegated',
    credentialDomain: 'communications-delegated',
    executor: 'communications',
    delegatedPermissions: [
      'openid',
      'profile',
      'offline_access',
      'User.Read',
      'Mail.ReadWrite',
      'Mail.Send',
      'Chat.ReadWrite',
      'ChannelMessage.Read.All',
      'ChannelMessage.Send',
    ],
    applicationPermissions: [],
  },
  'customer-graph-read': {
    id: 'customer-graph-read',
    version: 1,
    ownerAxis: 'organization',
    authMode: 'application-certificate',
    credentialDomain: 'customer-graph-read',
    executor: 'graph-read',
    delegatedPermissions: [],
    applicationPermissions: [
      'Organization.Read.All',
      'User.Read.All',
      'Device.Read.All',
      'Group.Read.All',
      'AuditLog.Read.All',
      'DeviceManagementManagedDevices.Read.All',
      'DeviceManagementConfiguration.Read.All',
      'Sites.Read.All',
    ],
  },
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
      'Group.ReadWrite.All',
      'DeviceManagementManagedDevices.PrivilegedOperations.All',
      'DeviceManagementConfiguration.ReadWrite.All',
      'Sites.ReadWrite.All',
    ],
  },
  'customer-exchange-powershell': {
    id: 'customer-exchange-powershell',
    version: 1,
    ownerAxis: 'organization',
    authMode: 'application-certificate',
    credentialDomain: 'customer-exchange-powershell',
    executor: 'exchange-powershell',
    delegatedPermissions: [],
    applicationPermissions: ['Exchange.ManageAsApp'],
  },
} as const satisfies Record<M365ConnectionProfile, M365PermissionProfileManifest>;

export function getM365PermissionProfile(id: M365ConnectionProfile): M365PermissionProfileManifest {
  return M365_PERMISSION_PROFILES[id];
}

export function connectionNeedsConsentReconciliation(
  id: M365ConnectionProfile,
  storedVersion: number,
): boolean {
  return getM365PermissionProfile(id).version !== storedVersion;
}
```

- [ ] **Step 4: Run the focused test**

Run: `pnpm --filter @breeze/api test:run -- src/services/m365ControlPlane/profiles.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit the profile contracts**

```bash
git add apps/api/src/services/m365ControlPlane/profiles.ts apps/api/src/services/m365ControlPlane/profiles.test.ts
git commit -m "feat(m365): add versioned permission profiles"
```

---

### Task 2: Evolve `m365_connections` into canonical metadata

**Files:**
- Create: `apps/api/migrations/2026-07-13-m365-control-plane-foundation.sql`
- Modify: `apps/api/src/db/schema/m365.ts`
- Modify: `apps/api/src/db/schema/m365.test.ts`

**Interfaces:**
- Consumes: profile/domain/auth-mode string contracts from Task 1.
- Produces: one connection row owned by exactly one organization or user, with a vault reference for every non-legacy profile. The expand release temporarily retains one-row-per-org compatibility until all deployed writers use `(org_id, profile)`.

- [ ] **Step 1: Replace the schema test expectations before changing the schema**

```ts
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { m365Connections } from './m365';

describe('m365Connections schema', () => {
  it('has canonical metadata columns and only one deprecated secret column', () => {
    const cfg = getTableConfig(m365Connections);
    expect(cfg.columns.map((c) => c.name).sort()).toEqual([
      'client_id', 'client_secret', 'consented_at', 'created_at', 'created_by',
      'credential_domain', 'credential_version', 'display_name', 'expires_at',
      'id', 'last_error_code', 'last_verified_at', 'observed_grants', 'org_id',
      'permission_manifest_version', 'profile', 'revoked_at', 'status',
      'tenant_id', 'updated_at', 'user_id', 'vault_ref', 'auth_mode',
    ].sort());
    expect(cfg.columns.find((c) => c.name === 'client_secret')?.notNull).toBe(false);
    expect(cfg.columns.find((c) => c.name === 'vault_ref')?.notNull).toBe(false);
  });

  it('retains rollout compatibility alongside per-owner/profile uniqueness', () => {
    const names = getTableConfig(m365Connections).indexes.map((i) => i.config.name).sort();
    expect(names).toEqual([
      'm365_connections_org_uniq',
      'm365_connections_org_profile_uniq',
      'm365_connections_user_profile_uniq',
    ]);
  });
});
```

- [ ] **Step 2: Run the schema test and verify it fails against the legacy shape**

Run: `pnpm --filter @breeze/api test:run -- src/db/schema/m365.test.ts`

Expected: FAIL because the canonical columns and indexes are absent.

- [ ] **Step 3: Replace `apps/api/src/db/schema/m365.ts` with the canonical Drizzle model**

```ts
import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import type {
  M365AuthMode,
  M365ConnectionProfile,
  M365CredentialDomain,
} from '../../services/m365ControlPlane/profiles';

export type StoredM365ConnectionProfile = M365ConnectionProfile | 'legacy-direct';
export type StoredM365AuthMode = M365AuthMode | 'client-secret-legacy';
export type StoredM365CredentialDomain = M365CredentialDomain | 'legacy-direct';
export type M365ConnectionStatus =
  | 'pending-consent'
  | 'verifying'
  | 'active'
  | 'degraded'
  | 'suspended'
  | 'revoked';

export const m365Connections = pgTable(
  'm365_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    tenantId: varchar('tenant_id', { length: 36 }).notNull(),
    clientId: varchar('client_id', { length: 64 }).notNull(),
    clientSecret: text('client_secret'),
    profile: varchar('profile', { length: 64 }).$type<StoredM365ConnectionProfile>().notNull().default('legacy-direct'),
    authMode: varchar('auth_mode', { length: 40 }).$type<StoredM365AuthMode>().notNull().default('client-secret-legacy'),
    credentialDomain: varchar('credential_domain', { length: 64 }).$type<StoredM365CredentialDomain>().notNull().default('legacy-direct'),
    vaultRef: text('vault_ref'),
    credentialVersion: varchar('credential_version', { length: 128 }),
    permissionManifestVersion: integer('permission_manifest_version').notNull().default(0),
    observedGrants: jsonb('observed_grants').$type<string[]>().notNull().default([]),
    displayName: varchar('display_name', { length: 256 }),
    status: varchar('status', { length: 32 }).$type<M365ConnectionStatus>().notNull().default('pending-consent'),
    consentedAt: timestamp('consented_at', { withTimezone: true }),
    lastVerifiedAt: timestamp('last_verified_at'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastErrorCode: varchar('last_error_code', { length: 80 }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    orgUniq: uniqueIndex('m365_connections_org_uniq').on(t.orgId),
    orgProfileUniq: uniqueIndex('m365_connections_org_profile_uniq').on(t.orgId, t.profile),
    userProfileUniq: uniqueIndex('m365_connections_user_profile_uniq').on(t.userId, t.profile),
  }),
);

export type M365ConnectionRow = typeof m365Connections.$inferSelect;
export type NewM365ConnectionRow = typeof m365Connections.$inferInsert;
```

- [ ] **Step 4: Add the idempotent SQL migration**

```sql
-- Evolve the existing direct-M365 table into canonical control-plane metadata.
-- autoMigrate supplies the transaction; do not add BEGIN/COMMIT.
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS profile VARCHAR(64);
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS auth_mode VARCHAR(40);
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS credential_domain VARCHAR(64);
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS vault_ref TEXT;
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS credential_version VARCHAR(128);
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS permission_manifest_version INTEGER;
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS observed_grants JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS consented_at TIMESTAMPTZ;
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS last_error_code VARCHAR(80);

UPDATE m365_connections
SET profile = COALESCE(profile, 'legacy-direct'),
    auth_mode = COALESCE(auth_mode, 'client-secret-legacy'),
    credential_domain = COALESCE(credential_domain, 'legacy-direct'),
    permission_manifest_version = COALESCE(permission_manifest_version, 0)
WHERE profile IS NULL
   OR auth_mode IS NULL
   OR credential_domain IS NULL
   OR permission_manifest_version IS NULL;

ALTER TABLE m365_connections ALTER COLUMN org_id DROP NOT NULL;
ALTER TABLE m365_connections ALTER COLUMN client_secret DROP NOT NULL;
ALTER TABLE m365_connections ALTER COLUMN tenant_id TYPE VARCHAR(36);
ALTER TABLE m365_connections ALTER COLUMN profile SET NOT NULL;
ALTER TABLE m365_connections ALTER COLUMN auth_mode SET NOT NULL;
ALTER TABLE m365_connections ALTER COLUMN credential_domain SET NOT NULL;
ALTER TABLE m365_connections ALTER COLUMN permission_manifest_version SET NOT NULL;
ALTER TABLE m365_connections ALTER COLUMN status SET DEFAULT 'pending-consent';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'm365_connections_user_id_fkey'
      AND conrelid = 'm365_connections'::regclass
  ) THEN
    ALTER TABLE m365_connections
      ADD CONSTRAINT m365_connections_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

UPDATE m365_connections c
SET created_by = NULL
WHERE created_by IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.created_by);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'm365_connections_created_by_fkey'
      AND conrelid = 'm365_connections'::regclass
  ) THEN
    ALTER TABLE m365_connections
      ADD CONSTRAINT m365_connections_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_owner_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_owner_check
  CHECK ((org_id IS NOT NULL)::int + (user_id IS NOT NULL)::int = 1);

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_tenant_guid_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_tenant_guid_check
  CHECK (tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_profile_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_profile_check CHECK (profile IN (
  'legacy-direct', 'communications-delegated', 'customer-graph-read',
  'customer-graph-actions', 'customer-exchange-powershell'
));

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_status_check;
UPDATE m365_connections
SET status = 'degraded', last_error_code = 'legacy-status-normalized'
WHERE status NOT IN ('pending-consent', 'verifying', 'active', 'degraded', 'suspended', 'revoked');
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_status_check CHECK (status IN (
  'pending-consent', 'verifying', 'active', 'degraded', 'suspended', 'revoked'
));

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_manifest_version_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_manifest_version_check
  CHECK (
    (profile = 'legacy-direct' AND permission_manifest_version = 0)
    OR (profile <> 'legacy-direct' AND permission_manifest_version >= 1)
  );

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_observed_grants_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_observed_grants_check
  CHECK (jsonb_typeof(observed_grants) = 'array');

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_credential_location_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_credential_location_check CHECK (
  (profile = 'legacy-direct' AND client_secret IS NOT NULL AND vault_ref IS NULL)
  OR
  (profile <> 'legacy-direct' AND client_secret IS NULL AND vault_ref IS NOT NULL AND credential_version IS NOT NULL)
);

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_profile_binding_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_profile_binding_check CHECK (
  (profile = 'legacy-direct' AND org_id IS NOT NULL AND auth_mode = 'client-secret-legacy' AND credential_domain = 'legacy-direct')
  OR (profile = 'communications-delegated' AND user_id IS NOT NULL AND auth_mode = 'delegated' AND credential_domain = 'communications-delegated')
  OR (profile = 'customer-graph-read' AND org_id IS NOT NULL AND auth_mode = 'application-certificate' AND credential_domain = 'customer-graph-read')
  OR (profile = 'customer-graph-actions' AND org_id IS NOT NULL AND auth_mode = 'application-certificate' AND credential_domain = 'customer-graph-actions')
  OR (profile = 'customer-exchange-powershell' AND org_id IS NOT NULL AND auth_mode = 'application-certificate' AND credential_domain = 'customer-exchange-powershell')
);

-- Expand/contract compatibility for the old API's ON CONFLICT (org_id).
-- Remove only after every deployed writer targets (org_id, profile).
CREATE UNIQUE INDEX IF NOT EXISTS m365_connections_org_uniq
  ON m365_connections (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS m365_connections_org_profile_uniq
  ON m365_connections (org_id, profile);
CREATE UNIQUE INDEX IF NOT EXISTS m365_connections_user_profile_uniq
  ON m365_connections (user_id, profile);

DROP POLICY IF EXISTS breeze_org_isolation_select ON m365_connections;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON m365_connections;
DROP POLICY IF EXISTS breeze_org_isolation_update ON m365_connections;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON m365_connections;
DROP POLICY IF EXISTS breeze_m365_connection_select ON m365_connections;
DROP POLICY IF EXISTS breeze_m365_connection_insert ON m365_connections;
DROP POLICY IF EXISTS breeze_m365_connection_update ON m365_connections;
DROP POLICY IF EXISTS breeze_m365_connection_delete ON m365_connections;

ALTER TABLE m365_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE m365_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_m365_connection_select ON m365_connections FOR SELECT USING (
  public.breeze_current_scope() = 'system'
  OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
  OR (user_id IS NOT NULL AND user_id = public.breeze_current_user_id())
);
CREATE POLICY breeze_m365_connection_insert ON m365_connections FOR INSERT WITH CHECK (
  public.breeze_current_scope() = 'system'
  OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
  OR (user_id IS NOT NULL AND user_id = public.breeze_current_user_id())
);
CREATE POLICY breeze_m365_connection_update ON m365_connections FOR UPDATE USING (
  public.breeze_current_scope() = 'system'
  OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
  OR (user_id IS NOT NULL AND user_id = public.breeze_current_user_id())
) WITH CHECK (
  public.breeze_current_scope() = 'system'
  OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
  OR (user_id IS NOT NULL AND user_id = public.breeze_current_user_id())
);
CREATE POLICY breeze_m365_connection_delete ON m365_connections FOR DELETE USING (
  public.breeze_current_scope() = 'system'
  OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
  OR (user_id IS NOT NULL AND user_id = public.breeze_current_user_id())
);
```

- [ ] **Step 5: Run schema, migration, and build checks**

Run: `pnpm --filter @breeze/api test:run -- src/db/schema/m365.test.ts`

Expected: PASS, 2 tests.

Run: `pnpm --filter @breeze/api check:migrations`

Expected: exit 0 with the new migration accepted.

Run: `pnpm --filter @breeze/api build`

Expected: FAIL only if legacy consumers still assume `clientSecret` is non-null; Task 3 resolves those failures before its commit.

---

### Task 3: Preserve existing direct-M365 behavior as explicit legacy access

**Files:**
- Modify: `apps/api/src/services/m365DirectGraph.ts`
- Modify: `apps/api/src/routes/m365.ts`
- Modify: `apps/api/src/routes/m365.test.ts`

**Interfaces:**
- Consumes: canonical `m365Connections` shape from Task 2.
- Produces: fail-closed compatibility behavior that can never select a new vault-backed profile.

- [ ] **Step 1: Add route assertions for the transitional fields**

Extend the mutable mock state and insert builder so the test can inspect the row passed to Drizzle:

```ts
let insertedValues: unknown;

vi.mock('../db/schema/m365', () => ({
  m365Connections: {
    orgId: 'org_id',
    profile: 'profile',
    status: 'status',
  },
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => selectRows) })) })) })),
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => {
        insertedValues = values;
        return { onConflictDoUpdate: vi.fn(() => ({ returning: vi.fn(async () => insertRows) })) };
      }),
    })),
    delete: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => deleteRows) })) })),
  },
}));
```

Set `insertedValues = undefined` in `beforeEach()`.

Extend the stored test row with:

```ts
profile: 'legacy-direct',
authMode: 'client-secret-legacy',
credentialDomain: 'legacy-direct',
vaultRef: null,
permissionManifestVersion: 0,
observedGrants: [],
```

Then add this assertion to the existing POST test:

```ts
expect(insertedValues).toMatchObject({
  profile: 'legacy-direct',
  authMode: 'client-secret-legacy',
  credentialDomain: 'legacy-direct',
  permissionManifestVersion: 0,
  vaultRef: null,
});
```

Add a unit test for a legacy row with `clientSecret: null`:

```ts
it('does not attempt Graph auth when a legacy row has no encrypted secret', async () => {
  selectRows = [{ ...storedRow, clientSecret: null }];
  const res = await app().request('/m365/connection');
  expect(res.status).toBe(200);
  expect((await res.json()).connected).toBe(true);
});
```

- [ ] **Step 2: Run the route tests and verify the write assertion fails**

Run: `pnpm --filter @breeze/api test:run -- src/routes/m365.test.ts`

Expected: FAIL because the legacy discriminator fields are not written.

- [ ] **Step 3: Filter every compatibility query and write the discriminator fields**

In `routes/m365.ts`, add `and` to the `drizzle-orm` import and define the reusable predicate:

```ts
const legacyDirectForOrg = (orgId: string) =>
  and(eq(m365Connections.orgId, orgId), eq(m365Connections.profile, 'legacy-direct'));
```

Use `legacyDirectForOrg(orgId)` for GET and DELETE. Change the upsert conflict target to `[m365Connections.orgId, m365Connections.profile]`. Add these fields to the existing upsert values:

```ts
profile: 'legacy-direct',
authMode: 'client-secret-legacy',
credentialDomain: 'legacy-direct',
vaultRef: null,
credentialVersion: null,
permissionManifestVersion: 0,
observedGrants: [],
```

In `m365DirectGraph.ts`, add `and` to the `drizzle-orm` import and replace its connection lookup with:

```ts
const [row] = await db
  .select()
  .from(m365Connections)
  .where(and(
    eq(m365Connections.orgId, orgId),
    eq(m365Connections.profile, 'legacy-direct'),
    eq(m365Connections.status, 'active'),
  ))
  .limit(1);

if (!row) {
  return { kind: 'error', code: 'no_connection', message: 'No legacy Microsoft 365 connection for this organization.' };
}
if (!row.clientSecret) {
  return { kind: 'error', code: 'connection_key_error', message: 'Legacy Microsoft 365 connection has no stored client secret.' };
}
```

Apply the same `profile = 'legacy-direct'` condition in `hasDirectM365Connection()`.

- [ ] **Step 4: Run focused tests and build**

Run: `pnpm --filter @breeze/api test:run -- src/routes/m365.test.ts src/services/m365DirectGraph.test.ts src/db/schema/m365.test.ts`

Expected: PASS.

Run: `pnpm --filter @breeze/api build`

Expected: exit 0.

- [ ] **Step 5: Commit canonical schema and compatibility together**

```bash
git add apps/api/migrations/2026-07-13-m365-control-plane-foundation.sql apps/api/src/db/schema/m365.ts apps/api/src/db/schema/m365.test.ts apps/api/src/services/m365DirectGraph.ts apps/api/src/routes/m365.ts apps/api/src/routes/m365.test.ts
git commit -m "feat(m365): establish canonical connection metadata"
```

---

### Task 4: Prove dual-axis RLS with the real application role

**Files:**
- Create: `apps/api/src/__tests__/integration/m365ConnectionsRls.integration.test.ts`

**Interfaces:**
- Consumes: `m365Connections`, `withDbAccessContext`, `withSystemDbAccessContext`, and the migration from Task 2.
- Produces: non-vacuous cross-organization and user-owner isolation evidence.

- [ ] **Step 1: Write the complete real-database forge test**

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { m365Connections } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const tenantA = '11111111-1111-1111-1111-111111111111';
const tenantB = '22222222-2222-2222-2222-222222222222';

async function seedFixture() {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const userA = await createUser({
      partnerId: partnerA.id,
      orgId: orgA.id,
      email: `m365-rls-a-${Date.now()}@example.com`,
    });
    const userB = await createUser({
      partnerId: partnerB.id,
      orgId: orgB.id,
      email: `m365-rls-b-${Date.now()}@example.com`,
    });

    const [orgBConnection] = await db.insert(m365Connections).values({
      orgId: orgB.id,
      userId: null,
      tenantId: tenantB,
      clientId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      clientSecret: null,
      profile: 'customer-graph-read',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: 'akv://vault.example/m365-customer-graph-read-b/1',
      credentialVersion: '1',
      permissionManifestVersion: 1,
      status: 'active',
    }).returning({ id: m365Connections.id });
    if (!orgBConnection) throw new Error('failed to seed foreign connection');

    const orgAContext: DbAccessContext = {
      scope: 'organization',
      orgId: orgA.id,
      accessibleOrgIds: [orgA.id],
      accessiblePartnerIds: [partnerA.id],
      userId: userA.id,
    };

    return { partnerA, orgA, orgB, userA, userB, orgBConnection, orgAContext };
  });
}

describe('m365_connections dual-axis RLS', () => {
  runDb('runs code-under-test as breeze_app without BYPASSRLS', async () => {
    const fx = await seedFixture();
    const rows = await withDbAccessContext(fx.orgAContext, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row).toEqual({ who: 'breeze_app', rolbypassrls: false });
  });

  runDb('hides another organization connection and blocks a forged insert', async () => {
    const fx = await seedFixture();
    const hidden = await withDbAccessContext(fx.orgAContext, () =>
      db.select({ id: m365Connections.id }).from(m365Connections)
        .where(eq(m365Connections.id, fx.orgBConnection.id)));
    expect(hidden).toEqual([]);

    await expect(withDbAccessContext(fx.orgAContext, () => db.insert(m365Connections).values({
      orgId: fx.orgB.id,
      userId: null,
      tenantId: tenantB,
      clientId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      clientSecret: null,
      profile: 'customer-graph-actions',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-actions',
      vaultRef: 'akv://vault.example/m365-customer-graph-actions-forged/1',
      credentialVersion: '1',
      permissionManifestVersion: 1,
      status: 'active',
    }))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('allows the current user to own communications but blocks another user', async () => {
    const fx = await seedFixture();
    const [own] = await withDbAccessContext(fx.orgAContext, () => db.insert(m365Connections).values({
      orgId: null,
      userId: fx.userA.id,
      tenantId: tenantA,
      clientId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      clientSecret: null,
      profile: 'communications-delegated',
      authMode: 'delegated',
      credentialDomain: 'communications-delegated',
      vaultRef: 'akv://vault.example/m365-communications-user-a/1',
      credentialVersion: '1',
      permissionManifestVersion: 1,
      status: 'active',
    }).returning({ id: m365Connections.id, userId: m365Connections.userId }));
    expect(own?.userId).toBe(fx.userA.id);

    await expect(withDbAccessContext(fx.orgAContext, () => db.insert(m365Connections).values({
      orgId: null,
      userId: fx.userB.id,
      tenantId: tenantB,
      clientId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      clientSecret: null,
      profile: 'communications-delegated',
      authMode: 'delegated',
      credentialDomain: 'communications-delegated',
      vaultRef: 'akv://vault.example/m365-communications-user-b-forged/1',
      credentialVersion: '1',
      permissionManifestVersion: 1,
      status: 'active',
    }))).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
```

- [ ] **Step 2: Run the focused integration and RLS coverage suites**

Run: `pnpm --filter @breeze/api test:integration -- src/__tests__/integration/m365ConnectionsRls.integration.test.ts`

Expected: PASS when `DATABASE_URL` points at the test database; otherwise the three `runDb` cases are skipped explicitly.

Run: `pnpm --filter @breeze/api test:rls-coverage`

Expected: PASS with `m365_connections` still recognized as a protected tenant table.

- [ ] **Step 3: Commit the isolation proof**

```bash
git add apps/api/src/__tests__/integration/m365ConnectionsRls.integration.test.ts
git commit -m "test(m365): prove connection tenant isolation"
```

---

### Task 5: Add the executor-only Azure Key Vault credential provider

**Files:**
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/api/src/executors/m365/credentials/types.ts`
- Create: `apps/api/src/executors/m365/credentials/azureKeyVaultProvider.ts`
- Create: `apps/api/src/executors/m365/credentials/azureKeyVaultProvider.test.ts`

**Interfaces:**
- Consumes: `M365CredentialDomain` from Task 1.
- Produces: `CredentialProvider.put()` and `.get()` with domain-checked versioned `akv://` references. Name-wide deletion is deferred to a DB-backed lifecycle workflow that serializes against rotation.
- Security boundary: no route, AI tool, or control-plane service imports this directory.

- [ ] **Step 1: Add Azure SDK dependencies**

Run: `pnpm --filter @breeze/api add @azure/identity@^4.6.0 @azure/keyvault-secrets@^4.9.0`

Expected: `apps/api/package.json` contains both dependencies and `pnpm-lock.yaml` is updated.

- [ ] **Step 2: Write the provider tests with a mocked SecretClient port**

```ts
import { describe, expect, it, vi } from 'vitest';
import { AzureKeyVaultCredentialProvider, type SecretClientPort } from './azureKeyVaultProvider';

function client(): SecretClientPort {
  return {
    setSecret: vi.fn(async () => ({ properties: { version: 'version-1' } })),
    getSecret: vi.fn(async () => ({
      value: JSON.stringify({
        schemaVersion: 1,
        domain: 'customer-graph-read',
        material: {
          kind: 'certificate',
          certificatePem: 'CERT',
          privateKeyPem: 'PRIVATE',
          thumbprint: 'THUMB',
        },
      }),
    })),
  };
}

describe('AzureKeyVaultCredentialProvider', () => {
  it('returns a versioned reference without returning the stored material', async () => {
    const port = client();
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);
    const stored = await provider.put({
      connectionId: '11111111-1111-1111-1111-111111111111',
      domain: 'customer-graph-read',
      material: { kind: 'certificate', certificatePem: 'CERT', privateKeyPem: 'PRIVATE', thumbprint: 'THUMB' },
    });
    expect(stored).toEqual({
      reference: 'akv://vault.example/m365-customer-graph-read-11111111-1111-1111-1111-111111111111/version-1',
      version: 'version-1',
    });
    expect(JSON.stringify(stored)).not.toContain('PRIVATE');
  });

  it('returns material only when the expected credential domain matches', async () => {
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', client());
    const material = await provider.get(
      'akv://vault.example/m365-customer-graph-read-11111111-1111-1111-1111-111111111111/version-1',
      'customer-graph-read',
    );
    expect(material.kind).toBe('certificate');
    await expect(provider.get(
      'akv://vault.example/m365-customer-graph-read-11111111-1111-1111-1111-111111111111/version-1',
      'customer-graph-actions',
    )).rejects.toThrow('Credential domain mismatch');
  });

  it('rejects references for a different vault host', async () => {
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', client());
    await expect(provider.get(
      'akv://other-vault.example/m365-customer-graph-read-id/version-1',
      'customer-graph-read',
    )).rejects.toThrow('Credential reference vault mismatch');
  });

  it('rejects a malformed credential envelope', async () => {
    const port = client();
    port.getSecret = vi.fn(async () => ({
      value: JSON.stringify({
        schemaVersion: 1,
        domain: 'customer-graph-read',
        material: { kind: 'unknown-secret-kind', value: 'SECRET' },
      }),
    }));
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);
    await expect(provider.get(
      'akv://vault.example/m365-customer-graph-read-id/version-1',
      'customer-graph-read',
    )).rejects.toThrow('Credential secret has an unsupported envelope');
  });

  it('rejects a refresh token in a certificate credential domain', async () => {
    const port = client();
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);
    await expect(provider.put({
      connectionId: '11111111-1111-1111-1111-111111111111',
      domain: 'customer-graph-read',
      material: { kind: 'delegated-refresh-token', refreshToken: 'REFRESH' },
    })).rejects.toThrow('Credential material does not match credential domain');
    expect(port.setSecret).not.toHaveBeenCalled();
  });

});
```

- [ ] **Step 3: Run the provider test and verify the missing module failure**

Run: `pnpm --filter @breeze/api test:run -- src/executors/m365/credentials/azureKeyVaultProvider.test.ts`

Expected: FAIL because the provider files do not exist.

- [ ] **Step 4: Define credential material and the provider interface**

```ts
import type { M365CredentialDomain } from '../../../services/m365ControlPlane/profiles';

export type M365CredentialMaterial =
  | { kind: 'delegated-refresh-token'; refreshToken: string }
  | { kind: 'certificate'; certificatePem: string; privateKeyPem: string; thumbprint: string };

export interface StoredCredentialReference {
  reference: string;
  version: string;
}

export interface CredentialProvider {
  put(input: {
    connectionId: string;
    domain: M365CredentialDomain;
    material: M365CredentialMaterial;
  }): Promise<StoredCredentialReference>;
  get(reference: string, expectedDomain: M365CredentialDomain): Promise<M365CredentialMaterial>;
}
```

- [ ] **Step 5: Implement the Azure provider**

```ts
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import {
  M365_CREDENTIAL_DOMAINS,
  type M365CredentialDomain,
} from '../../../services/m365ControlPlane/profiles';
import type { CredentialProvider, M365CredentialMaterial, StoredCredentialReference } from './types';

interface CredentialEnvelope {
  schemaVersion: 1;
  domain: M365CredentialDomain;
  material: M365CredentialMaterial;
}

export interface SecretClientPort {
  setSecret(name: string, value: string, options?: unknown): Promise<{ properties: { version?: string } }>;
  getSecret(name: string, options?: { version?: string }): Promise<{ value?: string }>;
}

interface ParsedReference {
  host: string;
  name: string;
  version: string;
}

const CONNECTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function materialMatchesDomain(
  domain: M365CredentialDomain,
  material: M365CredentialMaterial,
): boolean {
  return domain === 'communications-delegated'
    ? material.kind === 'delegated-refresh-token'
    : material.kind === 'certificate';
}

function parseReference(reference: string): ParsedReference {
  const url = new URL(reference);
  const [name, version, extra] = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'akv:' || !url.hostname || !name || !version || extra) {
    throw new Error('Invalid Azure Key Vault credential reference');
  }
  return { host: url.hostname, name, version };
}

function parseEnvelope(value: string | undefined): CredentialEnvelope {
  if (!value) throw new Error('Credential secret has no value');
  const parsed = JSON.parse(value) as Partial<CredentialEnvelope>;
  const domainValid = M365_CREDENTIAL_DOMAINS.includes(parsed.domain as M365CredentialDomain);
  const material = parsed.material;
  const delegatedValid = material?.kind === 'delegated-refresh-token'
    && typeof material.refreshToken === 'string'
    && material.refreshToken.length > 0;
  const certificateValid = material?.kind === 'certificate'
    && typeof material.certificatePem === 'string'
    && material.certificatePem.length > 0
    && typeof material.privateKeyPem === 'string'
    && material.privateKeyPem.length > 0
    && typeof material.thumbprint === 'string'
    && material.thumbprint.length > 0;
  if (parsed.schemaVersion !== 1 || !domainValid || (!delegatedValid && !certificateValid)) {
    throw new Error('Credential secret has an unsupported envelope');
  }
  return parsed as CredentialEnvelope;
}

export class AzureKeyVaultCredentialProvider implements CredentialProvider {
  private readonly vaultHost: string;

  constructor(vaultUrl: string, private readonly client: SecretClientPort) {
    const parsed = new URL(vaultUrl);
    if (parsed.protocol !== 'https:' || !parsed.hostname) throw new Error('Azure Key Vault URL must use HTTPS');
    this.vaultHost = parsed.hostname;
  }

  static fromEnvironment(): AzureKeyVaultCredentialProvider {
    const vaultUrl = process.env.M365_AZURE_KEY_VAULT_URL;
    if (!vaultUrl) throw new Error('M365_AZURE_KEY_VAULT_URL is required');
    return new AzureKeyVaultCredentialProvider(
      vaultUrl,
      new SecretClient(vaultUrl, new DefaultAzureCredential()) as unknown as SecretClientPort,
    );
  }

  async put(input: {
    connectionId: string;
    domain: M365CredentialDomain;
    material: M365CredentialMaterial;
  }): Promise<StoredCredentialReference> {
    if (!CONNECTION_ID_RE.test(input.connectionId)) throw new Error('Connection id must be a UUID');
    if (!materialMatchesDomain(input.domain, input.material)) {
      throw new Error('Credential material does not match credential domain');
    }
    const name = `m365-${input.domain}-${input.connectionId}`;
    const envelope: CredentialEnvelope = { schemaVersion: 1, domain: input.domain, material: input.material };
    const stored = await this.client.setSecret(name, JSON.stringify(envelope), {
      contentType: 'application/vnd.breeze.m365-credential+json',
      tags: { domain: input.domain, connectionId: input.connectionId },
    });
    const version = stored.properties.version;
    if (!version) throw new Error('Azure Key Vault did not return a secret version');
    return { reference: `akv://${this.vaultHost}/${name}/${version}`, version };
  }

  async get(reference: string, expectedDomain: M365CredentialDomain): Promise<M365CredentialMaterial> {
    const parsed = parseReference(reference);
    if (parsed.host !== this.vaultHost) throw new Error('Credential reference vault mismatch');
    if (!parsed.name.startsWith(`m365-${expectedDomain}-`)) throw new Error('Credential domain mismatch');
    const secret = await this.client.getSecret(parsed.name, { version: parsed.version });
    const envelope = parseEnvelope(secret.value);
    if (envelope.domain !== expectedDomain) throw new Error('Credential domain mismatch');
    if (!materialMatchesDomain(expectedDomain, envelope.material)) {
      throw new Error('Credential material does not match credential domain');
    }
    return envelope.material;
  }

}
```

- [ ] **Step 6: Run provider tests, the profile tests, and the API build**

Run: `pnpm --filter @breeze/api test:run -- src/executors/m365/credentials/azureKeyVaultProvider.test.ts src/services/m365ControlPlane/profiles.test.ts`

Expected: PASS, 10 tests.

Run: `pnpm --filter @breeze/api build`

Expected: exit 0.

- [ ] **Step 7: Verify the provider has no control-plane imports**

Run: `rg -n "executors/m365/credentials|azureKeyVaultProvider" apps/api/src/routes apps/api/src/services apps/api/src/modules`

Expected: no matches. Executor code is not imported by routes, AI tools, or general services.

- [ ] **Step 8: Commit the credential boundary**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/executors/m365/credentials
git commit -m "feat(m365): add isolated Key Vault credential provider"
```

---

### Task 6: Foundation regression gate

**Files:**
- No new files.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: fresh verification evidence and a clean boundary for the consent-and-verification plan.

- [ ] **Step 1: Run all focused unit tests**

Run: `pnpm --filter @breeze/api test:run -- src/services/m365ControlPlane/profiles.test.ts src/db/schema/m365.test.ts src/routes/m365.test.ts src/services/m365DirectGraph.test.ts src/executors/m365/credentials/azureKeyVaultProvider.test.ts`

Expected: all selected tests pass with zero failures.

- [ ] **Step 2: Run the real-database isolation test**

Run: `pnpm --filter @breeze/api test:integration -- src/__tests__/integration/m365ConnectionsRls.integration.test.ts`

Expected: all M365 connection RLS tests pass when the test database is configured.

- [ ] **Step 3: Run migration and RLS contract checks**

Run: `pnpm --filter @breeze/api check:migrations`

Expected: exit 0.

Run: `pnpm --filter @breeze/api test:rls-coverage`

Expected: exit 0 with no tenant-table coverage regressions.

- [ ] **Step 4: Run the API build**

Run: `pnpm --filter @breeze/api build`

Expected: exit 0.

- [ ] **Step 5: Inspect the final diff for forbidden credential paths**

Run: `git diff --check HEAD~4..HEAD`

Expected: no whitespace errors.

Run: `rg -n "refreshToken|privateKeyPem|clientSecret" apps/api/src/routes/m365.ts apps/api/src/services/m365ControlPlane apps/api/src/db/schema/m365.ts`

Expected: `clientSecret` appears only in the explicitly legacy route/schema path; `refreshToken` and `privateKeyPem` do not appear in routes or control-plane services.

- [ ] **Step 6: Record the verified handoff**

The consent-and-verification plan may begin only after the focused unit tests, real-role RLS test, migration checks, RLS coverage suite, and API build all pass in the same implementation branch.
