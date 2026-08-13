# Tenant Variables (PR 1 of #3409) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `tenant_variables` store — a dual-ownership (org XOR partner) key/value table with encrypted values, a permission-gated CRUD API, and a settings management UI — so an MSP can define a value once (S1 site token, vendor key, syslog collector) and, in later PRs, reference it from scripts.

**Architecture:** Standard Partner-Wide First dual-axis table (`org_id` XOR `partner_id`, one dual-axis RLS policy + a SELECT-only widening branch so an org session can *see* its partner's inherited variables). Every value — secret or not — is encrypted at rest via `secretCrypto` with AAD bound to the **row id**, so a ciphertext blob cannot be transplanted between rows/tenants. Secret values are write-only: never returned by any endpoint, no reveal endpoint, no-clobber on update. A thin `services/tenantVariables.ts` owns crypto + access conditions + CRUD so PR 2's per-device resolver can import it instead of re-deriving tenancy.

**Tech Stack:** Postgres 16 + hand-written SQL migrations, Drizzle ORM (typed queries only), Hono routes, Zod (v4) validators in `@breeze/shared`, Vitest (unit + integration), Astro + React islands + react-i18next for the UI.

**Scope boundary — this PR does NOT:** touch script content, add `{{var.*}}` tokens, resolve variables at dispatch, deliver anything to an agent, or change `scriptDispatch.ts`. Those are PRs 2–4. A variable created here is inert until PR 2. Docs (`apps/docs`) land in PR 2 with the user-visible token syntax.

## Global Constraints

- **Issue:** #3409. Scope comment: `gh api repos/lanternops/breeze/issues/comments/5248871605`. PR 0 (merged): #3418 + #3438.
- **Table name:** `tenant_variables` (not `script_variables` — software deploy will consume the same store in PR 2).
- **Key grammar:** `^[a-z][a-z0-9_]{0,63}$`. Enforced in Zod **and** as a DB CHECK constraint.
- **Caps:** value ≤ 4096 chars (plaintext), description ≤ 500 chars, 200 variables per owner (per org, and per partner).
- **Key is immutable** after create (v1). Renaming would silently break every script referencing the old token; delete + recreate instead.
- **Values are never returned for `is_secret = true` rows** — no endpoint, no query param, no admin bypass. Non-secret values ARE returned in full (that is the point of a non-secret variable).
- **Partner-wide writes** gate on `canManagePartnerWidePolicies(auth)` (`services/partnerWideAccess.ts`) and return `PARTNER_WIDE_WRITE_DENIED_MESSAGE` with 403.
- **`ownerScope` is create-only.** Update schemas derived via `.partial()` must `.omit({ ownerScope: true })` — moving a variable between axes is not supported.
- **The partner id is ALWAYS taken from the caller's own token.** A client-supplied `partnerId` is never trusted.
- **Migrations:** idempotent, no inner `BEGIN;`/`COMMIT;`, never edit a shipped file. `2026-08-06-` is a closed date block.
- **Registration lists (all four):** `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY`, `DUAL_AXIS_TENANT_TABLES`, plus `encryptedColumnRegistry`. No device lists — `tenant_variables` has no `device_id`.
- **Web mutations** must go through `runAction` (`apps/web/src/lib/runAction.ts`).
- **i18n:** every new user-facing string needs a key in `apps/web/src/locales/en/*.json` **and** a real translation in all six other locales (`de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`). `localeParity.test.ts` fails on a missing key; `translationCoverage.test.ts` fails on an untranslated English duplicate.
- **Commit after every task.** Branch: `ToddHebebrand/tenant-variables-pr1` (already created off `origin/main`).

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-08-11-tenant-variables.sql` | table + XOR/key CHECKs + partial unique indexes + dual-axis RLS + partner-wide SELECT widening |
| `apps/api/migrations/2026-08-11-variables-permissions.sql` | seed `variables:read` / `variables:manage`, grant to system Org Admin roles |
| `apps/api/src/db/schema/tenantVariables.ts` | Drizzle table definition |
| `apps/api/src/services/tenantVariables.ts` | AAD crypto helpers, access condition, list/create/update/delete, caps |
| `apps/api/src/services/tenantVariables.test.ts` | unit tests for crypto + owner resolution + caps |
| `apps/api/src/routes/tenantVariables.ts` | Hono CRUD routes |
| `apps/api/src/routes/tenantVariables.test.ts` | route tests (auth, ownerScope gating, secret redaction, no-clobber) |
| `apps/api/src/__tests__/integration/tenantVariablesPartnerRls.integration.test.ts` | real-Postgres RLS suite |
| `packages/shared/src/validators/tenantVariables.ts` | Zod create/update schemas + grammar/caps constants |
| `packages/shared/src/validators/tenantVariables.test.ts` | validator coverage |
| `packages/shared/src/types/tenantVariables.ts` | `TenantVariable` API response type |
| `apps/web/src/pages/settings/variables.astro` | route shell |
| `apps/web/src/components/settings/TenantVariablesPage.tsx` | list + create/edit modal + delete |
| `apps/web/src/components/settings/TenantVariablesPage.test.tsx` | UI tests |

**Modified**

| Path | Change |
|---|---|
| `apps/api/src/db/schema/index.ts` | export `./tenantVariables` |
| `apps/api/src/index.ts` | mount `tenantVariableRoutes` |
| `apps/api/src/services/encryptedColumnRegistry.ts` | row-bound AAD support + `tenant_variables.value` entry |
| `apps/api/src/services/tenantCascade.ts` | add `'tenant_variables'` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | add `tenant_variables` policy |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | add to `DUAL_AXIS_TENANT_TABLES` |
| `apps/api/src/db/seed.ts` | two `DEFAULT_PERMISSIONS` rows |
| `packages/shared/src/constants/permissions.ts` | `VARIABLES_READ`, `VARIABLES_MANAGE` |
| `packages/shared/src/validators/index.ts`, `types/index.ts` | re-export the new modules |
| `apps/web/src/components/layout/Sidebar.tsx` | nav entry under Settings |
| `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR}/{settings,common}.json` | new keys |

---

### Task 1: Migration, Drizzle schema, and the four registrations

**Files:**
- Create: `apps/api/migrations/2026-08-11-tenant-variables.sql`
- Create: `apps/api/src/db/schema/tenantVariables.ts`
- Create: `apps/api/src/__tests__/integration/tenantVariablesPartnerRls.integration.test.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/src/services/tenantCascade.ts` (insert between `'support_sessions'` and `'ticket_alert_links'`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`DUAL_AXIS_TENANT_TABLES`)

**Interfaces:**
- Produces: `tenantVariables` Drizzle table with columns `id, partnerId, orgId, key, value, isSecret, description, version, createdBy, updatedBy, createdAt, updatedAt`. Task 3's service and Task 4's routes import it from `../db/schema`.

- [ ] **Step 1: Write the migration**

`apps/api/migrations/2026-08-11-tenant-variables.sql`:

```sql
-- Tenant variables (#3409 PR 1): a value defined once by an MSP and referenced
-- from scripts (PR 2) and software deployment (PR 2) instead of hardcoded per
-- customer. Dual-axis config table (Partner-Wide First, epic #2135): a row is
-- owned by EITHER an org (org_id set, partner_id NULL) OR a partner
-- (partner_id set, org_id NULL — "all orgs"). Precedence at resolution time is
-- org > partner (site is deferred; when sites land the order becomes
-- site > org > partner).
--
-- `value` always holds ciphertext written by services/tenantVariables.ts
-- (secretCrypto, AAD bound to the row id). It is NOT NULL and has no default:
-- a variable with no value is meaningless. is_secret only controls whether the
-- API is ever willing to return the plaintext; encryption is unconditional.
--
-- No children FK-reference this table, so it is a cascade leaf.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, guarded CHECKs, CREATE INDEX IF NOT
-- EXISTS, DROP POLICY IF EXISTS then CREATE. No inner BEGIN/COMMIT (autoMigrate
-- wraps each file in a transaction). No UPDATE/DELETE cleanup, so the
-- GET DIAGNOSTICS ROW_COUNT reporting rule does not apply.

CREATE TABLE IF NOT EXISTS tenant_variables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  key varchar(64) NOT NULL,
  value text NOT NULL,
  is_secret boolean NOT NULL DEFAULT false,
  description varchar(500),
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- Exactly one owner: org-scoped XOR partner-wide.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_variables_one_owner_chk'
      AND conrelid = 'tenant_variables'::regclass
  ) THEN
    ALTER TABLE tenant_variables
      ADD CONSTRAINT tenant_variables_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

-- Key grammar is a DB-level contract, not just Zod: PR 2 interpolates the key
-- into a {{var.<key>}} token and a BREEZE_VAR_<UPPER> env var name, so a key
-- containing whitespace/braces/'=' would produce an unparseable token or an
-- illegal env var. Enforced here so no write path (route, seed, backfill,
-- psql) can introduce one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_variables_key_chk'
      AND conrelid = 'tenant_variables'::regclass
  ) THEN
    ALTER TABLE tenant_variables
      ADD CONSTRAINT tenant_variables_key_chk
      CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$');
  END IF;
END $$;

-- One key per owner. Partial indexes (not a plain UNIQUE on both columns):
-- with one axis always NULL, a two-column UNIQUE would never collide, since
-- NULL is distinct from NULL in a unique index. These also serve as the
-- lookup indexes for the org_id / partner_id cascade + resolver paths, so no
-- separate single-column indexes are created.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_variables_org_key_uniq
  ON tenant_variables(org_id, key) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tenant_variables_partner_key_uniq
  ON tenant_variables(partner_id, key) WHERE partner_id IS NOT NULL;

-- RLS: dual-axis (org-access OR partner-access OR system), one policy for all
-- commands — mirrors 2026-07-10-ticket-forms.sql.
ALTER TABLE tenant_variables ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_variables FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_variables_isolation ON tenant_variables;
CREATE POLICY tenant_variables_isolation
  ON tenant_variables
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

-- Read-only widening: an ORG-scoped session may SELECT the partner-wide
-- variables of its own partner. breeze_has_partner_access() is flat partner
-- access and is false for an org token, so without this branch an org admin
-- could not see the inherited variables that apply to their own devices — and
-- the settings UI would show an empty list while dispatch (PR 2) still
-- resolved them. Writes are unaffected: permissive policies OR together and
-- this branch is FOR SELECT only. Same mechanism as
-- 2026-08-10-cis-baselines-partner-ownership.sql.
--
-- Agent contexts set currentPartnerId NULL (middleware/agentAuth.ts,
-- routes/agentWs.ts), so breeze_current_partner_id() is NULL there and this
-- branch exposes nothing to agents.
DROP POLICY IF EXISTS tenant_variables_partner_wide_select ON tenant_variables;
CREATE POLICY tenant_variables_partner_wide_select
  ON tenant_variables
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
```

- [ ] **Step 2: Write the Drizzle schema**

`apps/api/src/db/schema/tenantVariables.ts`:

```ts
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { users } from './users';

/**
 * Tenant variables (#3409). Dual-axis ownership (Partner-Wide First, epic
 * #2135): org_id XOR partner_id, enforced by tenant_variables_one_owner_chk.
 *
 * `value` is ALWAYS ciphertext — write it only through
 * services/tenantVariables.ts, which binds the AAD to the row id. Never
 * insert/update this column directly.
 */
export const tenantVariables = pgTable(
  'tenant_variables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 64 }).notNull(),
    value: text('value').notNull(),
    isSecret: boolean('is_secret').notNull().default(false),
    description: varchar('description', { length: 500 }),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull()
  },
  (t) => [
    uniqueIndex('tenant_variables_org_key_uniq').on(t.orgId, t.key).where(sql`org_id IS NOT NULL`),
    uniqueIndex('tenant_variables_partner_key_uniq').on(t.partnerId, t.key).where(sql`partner_id IS NOT NULL`)
  ]
);

export type TenantVariableRow = typeof tenantVariables.$inferSelect;
```

Then add `export * from './tenantVariables';` to `apps/api/src/db/schema/index.ts`, keeping the file's existing alphabetical grouping.

- [ ] **Step 3: Register in the three tenancy lists**

1. `apps/api/src/services/tenantCascade.ts` — insert into `CORE_ORG_CASCADE_DELETE_ORDER` between `'support_sessions'` and `'ticket_alert_links'` (localeCompare: `support_sessions` < `tenant_variables` < `ticket_alert_links`), with a comment:

```ts
  // tenant_variables (#3409): dual-axis (org_id XOR partner_id) — only the
  // org-owned rows are reachable here; partner-wide rows have org_id NULL and
  // survive an org erasure by design. Cascade leaf: nothing FK-references it.
  'tenant_variables',
```

2. `apps/api/src/services/tenantExportPolicyRegistry.ts` — add (keep the file's existing key ordering):

```ts
  "tenant_variables": tablePolicy("org_id", {
    "included": ["id","partner_id","org_id","key","is_secret","description","version","created_by","updated_by","created_at","updated_at"],
    "reviewedIncluded": [],
    "excludedSensitive": ["value"],
    "excludedOpen": []
  }),
```

3. `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — add `'tenant_variables'` to `DUAL_AXIS_TENANT_TABLES` with a comment noting the XOR CHECK and the SELECT-widening policy (the assertion looks for a policy naming `breeze_has_partner_access` for all four commands — `tenant_variables_isolation` provides it; the widening policy is SELECT-only and additive).

- [ ] **Step 4: Write the RLS integration suite**

`apps/api/src/__tests__/integration/tenantVariablesPartnerRls.integration.test.ts`, modeled on `ticketFormsPartnerRls.integration.test.ts`. Note the deliberate difference from that suite: org contexts here **can** read partner-wide rows (the widening policy), so the test asserts visibility, not invisibility.

```ts
/**
 * tenant_variables RLS — dual-axis (org OR partner) enforcement (#3409 PR 1).
 * Migration under test: 2026-08-11-tenant-variables.sql.
 *
 * The rls-coverage contract test auto-discovers the org_id branch; it does NOT
 * prove the partner branch, the XOR CHECK, the key CHECK, or the SELECT-only
 * widening policy. That needs a functional test through the real postgres.js
 * driver as breeze_app — this suite. See memory: rls_dual_axis_contract_test_blindspot.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { tenantVariables } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const created: string[] = [];

function systemContext(): DbAccessContext {
  return { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
}
function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null, currentPartnerId: partnerId };
}
function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: partnerId };
}

const base = { key: 's1_site_token', value: 'enc-placeholder', isSecret: false };

afterEach(async () => {
  if (created.length === 0) return;
  await withDbAccessContext(systemContext(), async () => {
    for (const id of created) await db.delete(tenantVariables).where(eq(tenantVariables.id, id));
  });
  created.length = 0;
});

describe('tenant_variables partner RLS', () => {
  it('partner B forging partner A partner_id is rejected (42501)', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db.insert(tenantVariables).values({ ...base, partnerId: partnerA.id, orgId: null }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('XOR owner check: both or neither owner violates 23514', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await expect(
      withDbAccessContext(systemContext(), () =>
        db.insert(tenantVariables).values({ ...base, partnerId: partner.id, orgId: org.id }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(
      withDbAccessContext(systemContext(), () =>
        db.insert(tenantVariables).values({ ...base, partnerId: null, orgId: null }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('key CHECK rejects an illegal key (23514)', async () => {
    const partner = await createPartner();
    await expect(
      withDbAccessContext(systemContext(), () =>
        db.insert(tenantVariables).values({ ...base, key: 'Bad Key', partnerId: partner.id, orgId: null }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('duplicate key per owner is rejected (23505) but the same key on another owner is fine', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const rows = await withDbAccessContext(systemContext(), () =>
      db.insert(tenantVariables).values([
        { ...base, orgId: orgA.id, partnerId: null },
        { ...base, orgId: orgB.id, partnerId: null },
        { ...base, orgId: null, partnerId: partner.id }
      ]).returning()
    );
    created.push(...rows.map((r) => r.id));
    await expect(
      withDbAccessContext(systemContext(), () =>
        db.insert(tenantVariables).values({ ...base, orgId: orgA.id, partnerId: null }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('org B cannot read org A variables; an org CAN read its own partner-wide variables but not another partner-wide row', async () => {
    const partner = await createPartner();
    const otherPartner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });

    const rows = await withDbAccessContext(systemContext(), () =>
      db.insert(tenantVariables).values([
        { ...base, key: 'org_a_only', orgId: orgA.id, partnerId: null },
        { ...base, key: 'partner_wide', orgId: null, partnerId: partner.id },
        { ...base, key: 'other_partner', orgId: null, partnerId: otherPartner.id }
      ]).returning()
    );
    created.push(...rows.map((r) => r.id));
    const [orgRow, partnerRow, otherRow] = rows;

    const visibleToOrgB = await withDbAccessContext(orgContext(orgB.id, partner.id), () =>
      db.select().from(tenantVariables).where(eq(tenantVariables.id, orgRow!.id))
    );
    expect(visibleToOrgB).toEqual([]);

    // The widening policy: org session sees its OWN partner's partner-wide row.
    const inherited = await withDbAccessContext(orgContext(orgA.id, partner.id), () =>
      db.select().from(tenantVariables).where(eq(tenantVariables.id, partnerRow!.id))
    );
    expect(inherited.map((r) => r.key)).toEqual(['partner_wide']);

    // ...and NOT another partner's.
    const foreign = await withDbAccessContext(orgContext(orgA.id, partner.id), () =>
      db.select().from(tenantVariables).where(eq(tenantVariables.id, otherRow!.id))
    );
    expect(foreign).toEqual([]);
  });

  it('the widening policy is SELECT-only: an org session cannot UPDATE or DELETE an inherited partner-wide row', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [row] = await withDbAccessContext(systemContext(), () =>
      db.insert(tenantVariables).values({ ...base, orgId: null, partnerId: partner.id }).returning()
    );
    if (!row) throw new Error('insert returned no row');
    created.push(row.id);

    // RLS filters the row out of the UPDATE/DELETE target set rather than
    // raising — the assertion is that nothing changed, not that it threw.
    await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db.update(tenantVariables).set({ description: 'hijacked' }).where(eq(tenantVariables.id, row.id))
    );
    await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db.delete(tenantVariables).where(eq(tenantVariables.id, row.id))
    );
    const after = await withDbAccessContext(systemContext(), () =>
      db.select().from(tenantVariables).where(eq(tenantVariables.id, row.id))
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.description).toBeNull();
  });
});
```

- [ ] **Step 5: Apply the migration and run the suites**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
pnpm db:check-drift            # must report NO drift
pnpm --filter @breeze/api test:integration -- tenantVariablesPartnerRls
pnpm --filter @breeze/api test:integration -- rls-coverage tenantCascade tenant-export-policy
```
Expected: all green. If `db:check-drift` reports a diff on the partial unique indexes, fix the Drizzle `.where(...)` predicate to match the SQL text exactly.

Verify the boundary by hand as `breeze_app` (CLAUDE.md step 6):
```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze
-- with a forged org_id: must fail "new row violates row-level security policy"
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-08-11-tenant-variables.sql apps/api/src/db/schema/tenantVariables.ts \
  apps/api/src/db/schema/index.ts apps/api/src/services/tenantCascade.ts \
  apps/api/src/services/tenantExportPolicyRegistry.ts \
  apps/api/src/__tests__/integration/rls-coverage.integration.test.ts \
  apps/api/src/__tests__/integration/tenantVariablesPartnerRls.integration.test.ts
git commit -m "feat(api): add tenant_variables dual-axis table with RLS (#3409 PR1)"
```

---

### Task 2: Row-bound AAD in the encrypted-column registry

**Files:**
- Modify: `apps/api/src/services/encryptedColumnRegistry.ts`
- Modify: `apps/api/src/services/encryptedColumnRegistry.test.ts`

**Why:** `transformEncryptedColumnValue` builds AAD as `${table}.${column}` — a column-level binding. That stops a blob moving *between columns* but not between *rows*, so a DB-write attacker could paste another tenant's `tenant_variables.value` ciphertext into their own row and have PR 2's resolver decrypt it onto their device. The value must be bound to the row id. The rotation walker (`reencryptRegisteredSecrets`) already selects `id`, so it can rebuild the same AAD — it just needs to be told to.

**Interfaces:**
- Produces: `EncryptedColumnSpec.aadBinding?: 'column' | 'row'` (default `'column'`), `transformEncryptedColumnValue(spec, value, rowId?)`, and an exported `columnAad(spec, rowId?)` used by Task 3's service so the two can never drift.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/encryptedColumnRegistry.test.ts`:

```ts
describe('row-bound AAD', () => {
  const spec = {
    table: 'tenant_variables', column: 'value', kind: 'text' as const,
    aadBinding: 'row' as const, description: 'test',
  };

  it('columnAad includes the row id for row-bound specs', () => {
    expect(columnAad(spec, 'row-1')).toBe('tenant_variables.value:row-1');
    expect(columnAad({ ...spec, aadBinding: 'column' }, 'row-1')).toBe('tenant_variables.value');
  });

  it('throws when a row-bound spec is transformed without a row id', () => {
    expect(() => transformEncryptedColumnValue(spec, 'plaintext')).toThrow(/row id/i);
  });

  it('encryptColumnValueForWrite refuses row-bound columns', () => {
    expect(() => encryptColumnValueForWrite('tenant_variables', 'value', 'x')).toThrow(/row id/i);
  });

  it('a row-bound ciphertext decrypts only under its own row id', () => {
    process.env.APP_ENCRYPTION_KEY_ID = 'test-key';
    process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ 'test-key': 'unit-test-key-material' });
    const sealed = transformEncryptedColumnValue(spec, 'super-secret', 'row-1') as string;
    expect(decryptSecret(sealed, { aad: columnAad(spec, 'row-1') })).toBe('super-secret');
    expect(() => decryptSecret(sealed, { aad: columnAad(spec, 'row-2') })).toThrow();
  });
});
```
(Import `columnAad`, `encryptColumnValueForWrite`, `transformEncryptedColumnValue` from the module under test and `decryptSecret` from `./secretCrypto`; reset the two env vars in `afterEach`.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api test -- encryptedColumnRegistry`
Expected: FAIL — `columnAad is not a function`.

- [ ] **Step 3: Implement**

In `encryptedColumnRegistry.ts`:

```ts
export interface EncryptedColumnSpec {
  table: string;
  column: string;
  kind: EncryptedColumnKind;
  idColumn?: string;
  /**
   * 'column' (default): AAD is `table.column` — stops a blob moving between
   * columns. 'row': AAD is `table.column:<row id>` — additionally stops a blob
   * moving between ROWS, which for a tenant-owned column means between
   * TENANTS. Row-bound specs must be written through a caller that knows the
   * row id (see services/tenantVariables.ts); the generic
   * encryptColumnValueForWrite helper refuses them.
   */
  aadBinding?: 'column' | 'row';
  description: string;
}

export function columnAad(spec: EncryptedColumnSpec, rowId?: string): string {
  const base = `${spec.table}.${spec.column}`;
  if (spec.aadBinding !== 'row') return base;
  if (!rowId) throw new Error(`${base} is row-bound: a row id is required to derive its AAD`);
  return `${base}:${rowId}`;
}
```

`transformEncryptedColumnValue(spec, value, rowId?)` uses `columnAad(spec, rowId)` for its `aad`, and — for `aadBinding === 'row'` only — bypasses the `aadV3Enabled()` gate, since the table is new and has no v2 rows to migrate. Concretely, thread an `alwaysAad` boolean through `maybeReencryptString` so `withAad` is `aad` when `alwaysAad || aadV3Enabled()`.

`encryptColumnValueForWrite` calls `transformEncryptedColumnValue(spec, value)` with no row id, which now throws for row-bound specs — the intended fail-loud.

In `reencryptRegisteredSecrets`, pass the row id: `transformEncryptedColumnValue(spec, row.value, row.id)`.

Finally add the registry entry (keep the list's existing grouping, next to the other tenant-owned columns):

```ts
  { table: 'tenant_variables', column: 'value', kind: 'text', aadBinding: 'row', description: 'tenant variable value (#3409) — AAD bound to the row id' },
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/api test -- encryptedColumnRegistry secretCrypto`
Expected: PASS, including the pre-existing tests (the default `aadBinding` keeps every other spec byte-identical).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/encryptedColumnRegistry.ts apps/api/src/services/encryptedColumnRegistry.test.ts
git commit -m "feat(api): support row-bound AAD in the encrypted column registry (#3409 PR1)"
```

---

### Task 3: Shared validators, types, and the `variables` permission

**Files:**
- Create: `packages/shared/src/validators/tenantVariables.ts`
- Create: `packages/shared/src/validators/tenantVariables.test.ts`
- Create: `packages/shared/src/types/tenantVariables.ts`
- Create: `apps/api/migrations/2026-08-11-variables-permissions.sql`
- Modify: `packages/shared/src/constants/permissions.ts`, `packages/shared/src/validators/index.ts`, `packages/shared/src/types/index.ts`, `apps/api/src/db/seed.ts`

**Interfaces:**
- Produces: `createTenantVariableSchema`, `updateTenantVariableSchema`, `TENANT_VARIABLE_KEY_PATTERN`, `MAX_TENANT_VARIABLE_VALUE_LENGTH` (4096), `MAX_TENANT_VARIABLES_PER_OWNER` (200), type `TenantVariable`, grants `VARIABLES_READ` / `VARIABLES_MANAGE`.

- [ ] **Step 1: Write the failing validator tests**

`packages/shared/src/validators/tenantVariables.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createTenantVariableSchema, updateTenantVariableSchema } from './tenantVariables';

const valid = { ownerScope: 'organization' as const, key: 's1_site_token', value: 'abc123' };

describe('createTenantVariableSchema', () => {
  it('accepts a minimal org-scoped variable', () => {
    expect(createTenantVariableSchema.parse(valid)).toMatchObject({ key: 's1_site_token', isSecret: false });
  });

  it.each(['Bad', 'has space', '9leading', 'trailing-', 'a'.repeat(65), ''])('rejects key %j', (key) => {
    expect(createTenantVariableSchema.safeParse({ ...valid, key }).success).toBe(false);
  });

  it('rejects an empty or oversized value', () => {
    expect(createTenantVariableSchema.safeParse({ ...valid, value: '' }).success).toBe(false);
    expect(createTenantVariableSchema.safeParse({ ...valid, value: 'a'.repeat(4097) }).success).toBe(false);
  });

  it('requires orgId only for partner-scope callers to supply, and rejects unknown owner scopes', () => {
    expect(createTenantVariableSchema.safeParse({ ...valid, ownerScope: 'site' }).success).toBe(false);
    expect(createTenantVariableSchema.parse({ ...valid, ownerScope: 'partner' }).ownerScope).toBe('partner');
  });
});

describe('updateTenantVariableSchema', () => {
  it('omits ownerScope and key — neither is mutable', () => {
    const parsed = updateTenantVariableSchema.parse({ ownerScope: 'partner', key: 'renamed', description: 'x' });
    expect(parsed).toEqual({ description: 'x' });
  });

  it('accepts an empty object (no-op update)', () => {
    expect(updateTenantVariableSchema.safeParse({}).success).toBe(true);
  });

  it('still enforces the value cap', () => {
    expect(updateTenantVariableSchema.safeParse({ value: 'a'.repeat(4097) }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/shared test -- tenantVariables`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the validators and type**

`packages/shared/src/validators/tenantVariables.ts`:

```ts
import { z } from 'zod';

/** Lowercase snake_case; interpolated into {{var.<key>}} and BREEZE_VAR_<UPPER> (PR 2). */
export const TENANT_VARIABLE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_TENANT_VARIABLE_VALUE_LENGTH = 4096;
export const MAX_TENANT_VARIABLE_DESCRIPTION_LENGTH = 500;
/** Per owner (per org, and per partner). Bounds the PR 2 per-dispatch resolution query. */
export const MAX_TENANT_VARIABLES_PER_OWNER = 200;

const keySchema = z
  .string()
  .regex(TENANT_VARIABLE_KEY_PATTERN, 'Key must be lowercase letters, digits, and underscores, starting with a letter');
const valueSchema = z.string().min(1).max(MAX_TENANT_VARIABLE_VALUE_LENGTH);

export const createTenantVariableSchema = z.object({
  ownerScope: z.enum(['organization', 'partner']),
  /** Org-scope creates only; ignored for partner scope. Partner id always comes from the token. */
  orgId: z.string().guid().optional(),
  key: keySchema,
  value: valueSchema,
  isSecret: z.boolean().default(false),
  description: z.string().max(MAX_TENANT_VARIABLE_DESCRIPTION_LENGTH).optional()
});

/**
 * ownerScope and key are create-only: moving axes would change tenancy, and
 * renaming would silently break every script referencing the old token.
 * `.partial()` after `.omit()` so neither can arrive at all.
 */
export const updateTenantVariableSchema = createTenantVariableSchema
  .omit({ ownerScope: true, orgId: true, key: true })
  .partial();

export type CreateTenantVariableInput = z.infer<typeof createTenantVariableSchema>;
export type UpdateTenantVariableInput = z.infer<typeof updateTenantVariableSchema>;
```

> Zod 4 note: `.default(false)` on `isSecret` survives `.partial()` (see memory `zod4_partial_does_not_suppress_defaults`), which is why `updateTenantVariableSchema.parse({})` yields `{ isSecret: false }`. That is wrong for a PATCH — an update with no `isSecret` must not silently clear the flag. Strip the default on the update schema by redeclaring the field:
> ```ts
> export const updateTenantVariableSchema = createTenantVariableSchema
>   .omit({ ownerScope: true, orgId: true, key: true })
>   .partial()
>   .extend({ isSecret: z.boolean().optional() });
> ```
> and assert it in the test: `expect(updateTenantVariableSchema.parse({})).toEqual({})`.

`packages/shared/src/types/tenantVariables.ts`:

```ts
export type TenantVariableOwnerScope = 'organization' | 'partner';

/** API shape. `value` is null for secrets — they are write-only, with no reveal endpoint. */
export interface TenantVariable {
  id: string;
  key: string;
  value: string | null;
  isSecret: boolean;
  description: string | null;
  ownerScope: TenantVariableOwnerScope;
  orgId: string | null;
  partnerId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
```

Re-export both from the package barrels.

- [ ] **Step 4: Add the permission grants**

`packages/shared/src/constants/permissions.ts`, after the Scripts block:

```ts
  // Tenant variables (#3409) — the CRUD capability only. Script execution
  // implies USE of a reachable variable (a script can echo $BREEZE_VAR_X), so
  // this gate protects management, not exposure; see the threat model in the
  // #3409 scope comment.
  VARIABLES_READ: { resource: 'variables', action: 'read' },
  VARIABLES_MANAGE: { resource: 'variables', action: 'manage' },
```

`apps/api/src/db/seed.ts` `DEFAULT_PERMISSIONS`, after the Scripts block:

```ts
  // Tenant variables
  { resource: 'variables', action: 'read', description: 'View tenant variable definitions' },
  { resource: 'variables', action: 'manage', description: 'Create, edit, and delete tenant variables' },
```

- [ ] **Step 5: Write the permission seed migration**

`apps/api/migrations/2026-08-11-variables-permissions.sql`, modeled on `2026-07-18-b-approvals-decide-seed.sql`: an existence-guarded INSERT per grant (there is **no** unique constraint on `permissions(resource, action)`, so `ON CONFLICT DO NOTHING` is not a guard), then grant both to `roles` where `name = 'Org Admin' AND scope = 'organization' AND is_system = TRUE` (the `is_system` filter is load-bearing — custom roles accept a caller-supplied name). Report row counts with `GET DIAGNOSTICS` + `RAISE WARNING`. Partner Admin already holds `*:*` and needs no row.

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @breeze/shared test -- tenantVariables
pnpm --filter @breeze/api test -- permissions
pnpm db:migrate
```
Expected: PASS; migration applies twice with no change on the second run.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src apps/api/src/db/seed.ts apps/api/migrations/2026-08-11-variables-permissions.sql
git commit -m "feat(shared): tenant variable validators, types, and variables:* permissions (#3409 PR1)"
```

---

### Task 4: The service layer (`services/tenantVariables.ts`)

**Files:**
- Create: `apps/api/src/services/tenantVariables.ts`
- Create: `apps/api/src/services/tenantVariables.test.ts`

**Interfaces:**
- Consumes: `tenantVariables` (Task 1), `columnAad` (Task 2), the validators (Task 3), `canManagePartnerWidePolicies` (`services/partnerWideAccess.ts`).
- Produces:
  ```ts
  export class TenantVariableError extends Error { constructor(message: string, public status: number) }
  export function tenantVariableAccessCondition(auth: AuthContext): SQL | undefined
  export function encryptTenantVariableValue(id: string, plaintext: string): string
  export function decryptTenantVariableValue(row: Pick<TenantVariableRow, 'id' | 'value'>): string
  export function toApiTenantVariable(row: TenantVariableRow): TenantVariable
  export async function listTenantVariables(auth: AuthContext, filter?: { orgId?: string }): Promise<TenantVariable[]>
  export async function createTenantVariable(auth: AuthContext, input: CreateTenantVariableInput): Promise<TenantVariableRow>
  export async function updateTenantVariable(auth: AuthContext, id: string, input: UpdateTenantVariableInput): Promise<TenantVariableRow>
  export async function deleteTenantVariable(auth: AuthContext, id: string): Promise<TenantVariableRow>
  ```
  Task 5's routes call these; PR 2's resolver will call `decryptTenantVariableValue`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/tenantVariables.test.ts` — mock `../db` the way the repo's other service tests do (copy the mock shape from `apps/api/src/services/ticketFormService.test.ts` if present, otherwise from a neighboring service test). Cover:

```ts
it('round-trips a value through the row-bound AAD', () => {
  const sealed = encryptTenantVariableValue('11111111-1111-1111-1111-111111111111', 'hunter2');
  expect(sealed).not.toContain('hunter2');
  expect(decryptTenantVariableValue({ id: '11111111-1111-1111-1111-111111111111', value: sealed })).toBe('hunter2');
});

it('refuses to decrypt a value transplanted from another row', () => {
  const sealed = encryptTenantVariableValue('11111111-1111-1111-1111-111111111111', 'hunter2');
  expect(() => decryptTenantVariableValue({ id: '22222222-2222-2222-2222-222222222222', value: sealed })).toThrow();
});

it('toApiTenantVariable nulls the value for secrets and decrypts it for non-secrets', () => { /* both branches */ });

it('createTenantVariable rejects partner scope without canManagePartnerWidePolicies (403)', async () => { /* expect TenantVariableError status 403 */ });

it('createTenantVariable never trusts a caller-supplied partnerId', async () => { /* input carrying partnerId; assert the insert used auth.partnerId */ });

it('createTenantVariable rejects the 201st variable for an owner (409)', async () => { /* count mock returns 200 */ });

it('updateTenantVariable bumps version only when the value changes', async () => { /* value change → version+1; description-only → unchanged */ });

it('updateTenantVariable rejects clearing isSecret without supplying a new value (400)', async () => { /* the un-masking guard */ });

it('updateTenantVariable leaves the stored value untouched when value is omitted', async () => { /* no-clobber */ });
```

> **The `where`-clause assertion trap** (memory `vacuous_drizzle_where_clause_assertions`): asserting on the *stringified* Drizzle condition passes even if the condition is deleted. Assert on the **bound parameters** — capture the object passed to `.where()` and check `cond.queryChunks`/params contain the expected org id — and sanity-check by deleting the guard locally and watching the test go red.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api test -- tenantVariables`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Key implementation points:

```ts
import { randomUUID } from 'crypto';

const SPEC = { table: 'tenant_variables', column: 'value', kind: 'text', aadBinding: 'row', description: '' } as const;

export function encryptTenantVariableValue(id: string, plaintext: string): string {
  return encryptSecret(plaintext, { aad: columnAad(SPEC, id) }) ?? plaintext;
}

export function decryptTenantVariableValue(row: Pick<TenantVariableRow, 'id' | 'value'>): string {
  return decryptSecret(row.value, { aad: columnAad(SPEC, row.id) }) ?? '';
}
```

- The id is generated in the app (`randomUUID()`) and passed to the INSERT explicitly, because the AAD must bind to it *before* the row exists. This is a server-generated id — never accept one from the client.
- **Deployments with no `APP_ENCRYPTION_KEY_ID` seal to `enc:v1:` and ignore AAD** (`secretCrypto.encryptSecret`), and v1 decrypts fine with an AAD argument. Both configurations round-trip; the row binding only materializes once a key id is configured. Document this in a comment — it is the same degrade path every other registered column takes.
- `tenantVariableAccessCondition(auth)` mirrors `ticketFormAccessCondition` in `routes/tickets/forms.ts:63`: `auth.orgCondition(tenantVariables.orgId)`, OR'd with `(orgId IS NULL AND partnerId = auth.partnerId)` **only when `auth.scope === 'partner'`**… with one deliberate difference — because the DB has the SELECT-widening policy, org-scoped sessions may also read inherited rows, so the app-layer read condition adds the same branch for `auth.scope === 'organization' && auth.partnerId`. Writes must NOT use the widened condition: `getVariableWithAccess` for update/delete takes a `forWrite: true` flag that drops the partner-wide branch for org scope, keeping the app layer no looser than RLS.
- `createTenantVariable`: resolve the owner exactly as `routes/tickets/forms.ts:160-178` does (partner scope → `auth.partnerId` + `canManagePartnerWidePolicies`; org scope → `auth.orgId`, or a `canAccessOrg`-checked `orgId` for partner/system callers). Then count existing rows for that owner and throw `TenantVariableError('...', 409)` at `MAX_TENANT_VARIABLES_PER_OWNER`. Map a `23505` unique violation to a 409 with a "key already exists for this scope" message.
- `updateTenantVariable`: fetch with the write-access condition; 404 if absent; 403 via `canManagePartnerWidePolicies` when `row.orgId === null`; reject `isSecret: false` on a currently-secret row unless `value` is also supplied (400 — otherwise flipping the flag would unmask a stored secret); bump `version` only when `value` is supplied and decrypts to something different from the stored plaintext; always set `updatedBy` + `updatedAt`.
- `deleteTenantVariable`: same fetch + partner-wide gate, then delete, returning the row so the route can audit it.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/api test -- tenantVariables`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/tenantVariables.ts apps/api/src/services/tenantVariables.test.ts
git commit -m "feat(api): tenant variable service with row-bound value encryption (#3409 PR1)"
```

---

### Task 5: CRUD routes

**Files:**
- Create: `apps/api/src/routes/tenantVariables.ts`
- Create: `apps/api/src/routes/tenantVariables.test.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Consumes: everything from Task 4.
- Produces: `tenantVariableRoutes` (Hono), mounted at the API root so paths are absolute (`/tenant-variables`, `/tenant-variables/:id`).

**Endpoints**

| Method | Path | Gate | Body/query |
|---|---|---|---|
| GET | `/tenant-variables` | `variables:read` | `?orgId=<uuid>` optional filter |
| POST | `/tenant-variables` | `variables:manage` + `requireMfa()` | `createTenantVariableSchema` |
| PUT | `/tenant-variables/:id` | `variables:manage` + `requireMfa()` | `updateTenantVariableSchema` |
| DELETE | `/tenant-variables/:id` | `variables:manage` + `requireMfa()` | — |

All four: `authMiddleware` first (root-mounted router — a router-level `.use('*')` would attach auth to every sibling route, the #1383 footgun), then `requireScope('organization', 'partner', 'system')`.

- [ ] **Step 1: Write the failing route tests**

`apps/api/src/routes/tenantVariables.test.ts`, following the repo's route-test conventions (see `apps/api/src/routes/playbooks.test.ts` for the auth-mock shape). Cover:

- GET returns `value: null` for a secret row and the plaintext for a non-secret row.
- GET as an org-scoped caller includes inherited partner-wide rows, marked `ownerScope: 'partner'`.
- POST with `ownerScope: 'partner'` from an org-scoped caller → 403.
- POST with `ownerScope: 'partner'` from a partner caller with `partnerOrgAccess: 'selected'` → 403 with `PARTNER_WIDE_WRITE_DENIED_MESSAGE`.
- POST with a duplicate key for the same owner → 409.
- PUT omitting `value` leaves the stored ciphertext byte-identical (no-clobber).
- PUT with `isSecret: false` on a secret row and no `value` → 400.
- DELETE of a partner-wide row from an org caller → 404 (the write condition never matched), not 403.
- Every mutation writes an audit event whose `details` contain the key but **never** a value.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api test -- routes/tenantVariables`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the routes**

Thin handlers over the service; map `TenantVariableError` to `c.json({ error }, err.status)`. Audit via `writeRouteAudit(c, {...})` with `action: 'tenant_variable.create' | '.update' | '.delete'`, `resourceType: 'tenant_variable'`, `resourceName: row.key`, and `details: { key, ownerScope, isSecret, version, partnerWide: row.orgId === null }` — **no values, ever**. Mount in `apps/api/src/index.ts` alongside the other root-mounted routers.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/api test -- tenantVariables`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/tenantVariables.ts apps/api/src/routes/tenantVariables.test.ts apps/api/src/index.ts
git commit -m "feat(api): tenant variable CRUD routes (#3409 PR1)"
```

---

### Task 6: Settings UI

**Files:**
- Create: `apps/web/src/pages/settings/variables.astro`
- Create: `apps/web/src/components/settings/TenantVariablesPage.tsx`
- Create: `apps/web/src/components/settings/TenantVariablesPage.test.tsx`
- Modify: `apps/web/src/components/layout/Sidebar.tsx`
- Modify: `apps/web/src/locales/en/{settings,common}.json`

**Interfaces:**
- Consumes: the Task 5 endpoints via `fetchWithAuth` (which auto-injects `orgId` on reads — do NOT hand-append it; POST bodies still need explicit ownership fields).

- [ ] **Step 1: Write the failing UI tests**

`TenantVariablesPage.test.tsx` (Vitest + jsdom + Testing Library, `data-testid` selectors). Cover:
- renders a list with an "All orgs" badge on partner-wide rows;
- a secret row renders `••••••••` and no value text, and its edit modal shows the "leave blank to keep current value" hint;
- the create modal's ownerScope selector is absent for an org-scoped session (`isPartnerScope` false) — note memory `web_ispartnerscope_partners_length_gate_bug`: gate on scope, not `partners.length`;
- submitting create POSTs `{ ownerScope, key, value, isSecret }`;
- a failed POST surfaces an error toast (proving the `runAction` wrapper is present);
- the delete confirmation issues DELETE and refreshes the list.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/web test -- TenantVariablesPage`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the page**

Model the shell on `apps/web/src/components/settings/CustomFieldsPage.tsx` (same settings-page furniture) and the ownerScope selector on `apps/web/src/components/software/PolicyForm.tsx`. Requirements:
- `useTranslation('settings')`; every visible string comes from a key.
- All four mutations wrapped in `runAction` per CLAUDE.md, with the documented `ActionError` catch pattern.
- Secret values: `<input type="password" autoComplete="new-password">`; on edit the field starts empty and an empty submit omits `value` entirely.
- Row actions (edit/delete) hidden for inherited partner-wide rows when the session is org-scoped — they would 404 server-side.
- `data-testid` on: `tenant-variables-page`, `tenant-variable-row-<key>`, `tenant-variable-create-button`, `tenant-variable-key-input`, `tenant-variable-value-input`, `tenant-variable-secret-toggle`, `tenant-variable-owner-scope`, `tenant-variable-save`, `tenant-variable-delete-<key>`.

`variables.astro`:

```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import TenantVariablesPage from '../../components/settings/TenantVariablesPage';
---

<DashboardLayout title="Variables">
  <TenantVariablesPage client:load />
</DashboardLayout>
```

Sidebar entry, next to Custom Fields:

```ts
{ name: 'Variables', labelKey: 'nav.variables', href: '/settings/variables', icon: Braces, requiredPermission: { resource: 'variables', action: 'read' } },
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @breeze/web test -- TenantVariablesPage
pnpm --filter @breeze/web test -- no-silent-mutations
```
Expected: PASS (the second proves the `runAction` adoption guard is satisfied without an allowlist entry).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/settings/variables.astro apps/web/src/components/settings/TenantVariablesPage.tsx \
  apps/web/src/components/settings/TenantVariablesPage.test.tsx apps/web/src/components/layout/Sidebar.tsx \
  apps/web/src/locales/en
git commit -m "feat(web): tenant variables settings page (#3409 PR1)"
```

---

### Task 7: Translations and full-suite verification

**Files:**
- Modify: `apps/web/src/locales/{de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR}/{settings,common}.json`

- [ ] **Step 1: Run the parity tests to enumerate the gap**

Run: `pnpm --filter @breeze/web test -- localeParity translationCoverage`
Expected: FAIL, listing every key missing from the six translated locales.

- [ ] **Step 2: Add real translations**

Translate each new key in all six locales — not English copies. `translationCoverage.test.ts` caps exact-English duplicates per namespace, so an English placeholder either fails outright or forces a baseline bump that a reviewer will reject. Keep interpolation tokens (`{{count}}`, `{{key}}`) identical across locales — `localeParity.test.ts` compares token sets.

- [ ] **Step 3: Run the full local suite**

```bash
pnpm --filter @breeze/shared test
pnpm --filter @breeze/api test
pnpm --filter @breeze/web test
pnpm db:check-drift
pnpm --filter @breeze/api test:integration -- tenantVariables rls-coverage tenantCascade tenant-export-policy tenantExportErasureRoundtrip
```
Expected: all green. **Local green ≠ CI green** — the export-policy and cascade suites only fail under Integration Tests, so these two must be run explicitly here.

- [ ] **Step 4: Commit and open the PR**

```bash
git add apps/web/src/locales
git commit -m "i18n: translate tenant variables settings strings (#3409 PR1)"
git push -u origin ToddHebebrand/tenant-variables-pr1
```

PR body must call out: the new table and its four registrations; the row-bound AAD change to the shared registry; the new `variables:read` / `variables:manage` permission and its seed migration; that key and ownerScope are immutable; that secret values are write-only with no reveal endpoint; and that variables are inert until PR 2.

Run a deep code review **before** opening the PR — PR 0 shipped #3418 before its review finished and needed #3438 to clean up. Do not repeat that.

---

## Self-Review

**Spec coverage** (against the #3409 scope comment's PR-1 row: "`tenant_variables` migration + CRUD + registries + RLS suite + management UI"):

| Requirement | Task |
|---|---|
| `tenant_variables`, org XOR partner, partial unique indexes, precedence documented | 1 |
| copy the cis-baselines shape incl. partner-wide SELECT widening | 1 |
| `value` encrypted, AAD binds row identity not just table.column | 2, 4 |
| `version` counter for rotation tracking | 1 (column), 4 (bump rule) |
| `encryptedColumnRegistry` + `CORE_ORG_CASCADE_DELETE_ORDER` + `CORE_TENANT_EXPORT_POLICY` + `DUAL_AXIS_TENANT_TABLES` | 1, 2 |
| dedicated partner-RLS integration suite | 1 |
| partner-wide writes gated on `canManagePartnerWidePolicies` | 4, 5 |
| secret reads write-only, no reveal endpoint, no-clobber | 4, 5 |
| bounded count/value size | 3, 4 |
| masked CRUD audit | 5 |
| management UI (partner + org) | 6 |
| separate `variables:manage` permission | 3 |

Deferred by design, with the PR that owns each: `{{var.*}}` tokens + resolver + software-deploy wiring (PR 2), sourced parameters (PR 3), `secretEnv` delivery + redaction + digest pinning (PR 4), site axis (post-v1), docs (PR 2).

**Type consistency:** `TenantVariableRow` (Task 1) → `toApiTenantVariable` → `TenantVariable` (Task 3) is the single response shape used by Tasks 5 and 6. `columnAad(spec, rowId)` (Task 2) is the only AAD constructor, used by Task 4. `ownerScope` is spelled `'organization' | 'partner'` everywhere (matching `auth.scope`), never `'org'`.
