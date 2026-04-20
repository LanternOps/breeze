# MCP Agent-Deployable Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a feature-flagged MCP module that lets an external AI agent provision a Breeze tenant end-to-end (create → verify email → attach payment → configure → email installer invites → watch fleet enroll) via the existing MCP server.

**Architecture:** One region-local MCP endpoint per Breeze Cloud deployment with auth-aware `tools/list`. Three new unauthenticated bootstrap tools gated by `MCP_BOOTSTRAP_ENABLED` (default `false`). Activation is a three-state machine on the existing `partners` table (`pending_email` → `pending_payment` → `active`), with readonly API keys minted at email-click and upgraded in place to full scope after Stripe SetupIntent completes. All new code lives under `apps/api/src/modules/mcpBootstrap/` so it can be disabled or extracted as a unit.

**Tech Stack:** Hono (TypeScript API), Drizzle ORM + PostgreSQL, BullMQ + Redis (existing rate-limit + email job infra), Astro + React Islands (web activation page), Stripe SetupIntents via `breeze-billing`, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-20-mcp-agent-deployable-setup-design.md`

**Phasing:** The plan is organized into nine phases. Each phase ends at a stable, committable checkpoint. Phases 1–4 can ship without the feature flag being on (no user-visible behavior change). Phase 5 onward requires `MCP_BOOTSTRAP_ENABLED=true` in a staging environment to exercise end-to-end.

---

## File Structure

**New files:**

- `apps/api/migrations/2026-04-20-mcp-bootstrap-schema.sql` — idempotent migration for `partners` column additions, `partner_activations` table, `api_keys.scope_state`, `deployment_invites` table.
- `apps/api/src/db/schema/partnerActivations.ts` — Drizzle schema for the new table.
- `apps/api/src/db/schema/deploymentInvites.ts` — Drizzle schema for per-recipient invite tracking.
- `apps/api/src/services/partnerCreate.ts` — extracted reusable transaction (used by `/register-partner` and by `create_tenant`).
- `apps/api/src/services/breezeBillingClient.ts` — HTTP client for the existing `breeze-billing` service (Stripe SetupIntent creation, customer provisioning).
- `apps/api/src/services/activationEmail.ts` — builder for the activation email (matches existing `email.ts` template pattern).
- `apps/api/src/services/deploymentInviteEmail.ts` — builder for staff install invite emails.
- `apps/api/src/services/apiKeys.ts` — `mintApiKey({partnerId, name, scopeState, scopes, source})` helper.
- `apps/api/src/modules/mcpBootstrap/index.ts` — module entrypoint, dynamic-imported by `mcpServer.ts` when flag is on.
- `apps/api/src/modules/mcpBootstrap/types.ts` — tool typings + `BOOTSTRAP_TOOL_NAMES`.
- `apps/api/src/modules/mcpBootstrap/tools/createTenant.ts`
- `apps/api/src/modules/mcpBootstrap/tools/verifyTenant.ts`
- `apps/api/src/modules/mcpBootstrap/tools/attachPaymentMethod.ts`
- `apps/api/src/modules/mcpBootstrap/tools/sendDeploymentInvites.ts`
- `apps/api/src/modules/mcpBootstrap/tools/configureDefaults.ts`
- `apps/api/src/modules/mcpBootstrap/paymentGate.ts` — tool-wrap decorator.
- `apps/api/src/modules/mcpBootstrap/activationRoutes.ts` — `/activate/:token` + `/activate/complete` + Stripe webhook handler.
- `apps/api/src/modules/mcpBootstrap/inviteLandingRoutes.ts` — `/i/:short_code` OS-detecting installer redirect.
- `apps/api/src/modules/mcpBootstrap/startupCheck.ts` — hard env-var presence check when flag on.
- `apps/api/src/modules/mcpBootstrap/README.md` — explains feature flag, required envs, self-hoster note.
- `apps/api/src/routes/deleteTenant.ts` — new authed tier-3+ MCP tool (flag-independent).
- `packages/shared/src/validators/businessEmail.ts` — exported validator.
- `packages/shared/src/validators/businessEmail.test.ts`
- `apps/web/src/pages/activate/[token].astro` — Astro wrapper.
- `apps/web/src/pages/activate/complete.astro` — post-Stripe return page.
- `apps/web/src/components/activate/ActivateTokenPage.tsx` — React component.
- `apps/web/src/components/activate/ActivationComplete.tsx`
- Test files alongside each source file (Vitest, per CLAUDE.md placement rule).
- `apps/api/src/__tests__/integration/mcpBootstrap.integration.test.ts` — full-flow integration test.
- `e2e-tests/tests/mcp_bootstrap.yaml` — YAML E2E for a simulated agent run.
- `docs/superpowers/runbooks/2026-04-20-mcp-bootstrap-demo-rehearsal.md` — manual demo checklist.

**Modified files:**

- `apps/api/src/routes/mcpServer.ts` — auth-aware `tools/list`, bootstrap-tool carve-out, dynamic import of bootstrap module, readonly-scope backstop on tier-2+ tools.
- `apps/api/src/routes/auth/register.ts` — call extracted `createPartner()` instead of inline transaction (behavior unchanged).
- `apps/api/src/db/schema/apiKeys.ts` — add `scopeState` column.
- `apps/api/src/db/schema/partners.ts` — add `mcpOrigin`, `mcpOriginIp`, `mcpOriginUserAgent`, `emailVerifiedAt`, `paymentMethodAttachedAt`, `stripeCustomerId` columns.
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — add `partner_activations` and `deployment_invites` to `PARTNER_TENANT_TABLES`.
- `apps/api/src/index.ts` — mount activation routes + invite landing routes conditionally when flag on.
- `apps/api/src/services/aiTools.ts` — wire `delete_tenant` into the authed tool registry (flag-independent).
- `apps/web/src/pages/partner/settings/api-keys.astro` (or its component) — add `Source: MCP Provisioning` label for MCP-minted keys.
- `.env.example` — add new env vars with comments labelling them SaaS-only.

---

## Phase 1 — Foundation: migration, schema, service extraction

No behavior change. Feature flag not yet introduced (Phase 2). Each task is committable on its own.

### Task 1.1: Write the migration

**Files:**
- Create: `apps/api/migrations/2026-04-20-mcp-bootstrap-schema.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS mcp_origin BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mcp_origin_ip INET,
  ADD COLUMN IF NOT EXISTS mcp_origin_user_agent TEXT,
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_method_attached_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

CREATE TABLE IF NOT EXISTS partner_activations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_activations_partner ON partner_activations(partner_id);

ALTER TABLE partner_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_activations FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'partner_activations_partner_access') THEN
    CREATE POLICY partner_activations_partner_access ON partner_activations
      USING (breeze_has_partner_access(partner_id))
      WITH CHECK (breeze_has_partner_access(partner_id));
  END IF;
END $$;

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS scope_state TEXT NOT NULL DEFAULT 'full'
    CHECK (scope_state IN ('readonly', 'full'));

CREATE TABLE IF NOT EXISTS deployment_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  enrollment_key_id UUID NOT NULL REFERENCES enrollment_keys(id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,
  invited_by_api_key_id UUID REFERENCES api_keys(id),
  custom_message TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  clicked_at TIMESTAMPTZ,
  enrolled_at TIMESTAMPTZ,
  device_id UUID REFERENCES devices(id),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'clicked', 'enrolled', 'expired'))
);
CREATE INDEX IF NOT EXISTS idx_deployment_invites_partner ON deployment_invites(partner_id);
CREATE INDEX IF NOT EXISTS idx_deployment_invites_email ON deployment_invites(partner_id, invited_email);

ALTER TABLE deployment_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_invites FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deployment_invites_partner_access') THEN
    CREATE POLICY deployment_invites_partner_access ON deployment_invites
      USING (breeze_has_partner_access(partner_id))
      WITH CHECK (breeze_has_partner_access(partner_id));
  END IF;
END $$;
```

- [ ] **Step 2: Apply migration locally**

Run: `psql "$DATABASE_URL" -f apps/api/migrations/2026-04-20-mcp-bootstrap-schema.sql`
Expected: `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE`, `CREATE POLICY` messages, no errors. Re-run once to confirm idempotency (everything says `NOTICE: relation already exists, skipping` or equivalent).

- [ ] **Step 3: Verify RLS as `breeze_app`**

Run (inside the `breeze-postgres` container as user `breeze_app`):
`INSERT INTO partner_activations (partner_id, token_hash, expires_at) VALUES (gen_random_uuid(), 'x', now()+interval '1 day');`
Expected: `ERROR: new row violates row-level security policy for table "partner_activations"`.

- [ ] **Step 4: Commit**

Stage: `apps/api/migrations/2026-04-20-mcp-bootstrap-schema.sql`
Commit message: `feat(mcp-bootstrap): migration for partner activations + api_key scope_state + deployment_invites`

### Task 1.2: Update Drizzle schema files

**Files:**
- Create: `apps/api/src/db/schema/partnerActivations.ts`
- Create: `apps/api/src/db/schema/deploymentInvites.ts`
- Modify: `apps/api/src/db/schema/partners.ts`
- Modify: `apps/api/src/db/schema/apiKeys.ts`
- Modify: `apps/api/src/db/schema/index.ts` (add re-exports)

- [ ] **Step 1: Add columns to `partners.ts`**

Inside the existing `pgTable('partners', {...})` column object, after the last existing column, add:

```ts
mcpOrigin: boolean('mcp_origin').notNull().default(false),
mcpOriginIp: text('mcp_origin_ip'),
mcpOriginUserAgent: text('mcp_origin_user_agent'),
emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
paymentMethodAttachedAt: timestamp('payment_method_attached_at', { withTimezone: true }),
stripeCustomerId: text('stripe_customer_id'),
```

Note: `mcp_origin_ip` is `INET` in SQL; Drizzle has no first-class INET helper, `text()` maps cleanly since we only store IPv4/IPv6 strings.

- [ ] **Step 2: Add `scopeState` to `apiKeys.ts`**

```ts
scopeState: text('scope_state').notNull().default('full'),
```

- [ ] **Step 3: Create `partnerActivations.ts`**

```ts
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { partners } from './partners';

export const partnerActivations = pgTable('partner_activations', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id')
    .notNull()
    .references(() => partners.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PartnerActivation = typeof partnerActivations.$inferSelect;
export type NewPartnerActivation = typeof partnerActivations.$inferInsert;
```

- [ ] **Step 4: Create `deploymentInvites.ts`**

```ts
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { partners } from './partners';
import { organizations } from './organizations';
import { enrollmentKeys } from './enrollmentKeys';
import { apiKeys } from './apiKeys';
import { devices } from './devices';

export const deploymentInvites = pgTable('deployment_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  enrollmentKeyId: uuid('enrollment_key_id').notNull().references(() => enrollmentKeys.id, { onDelete: 'cascade' }),
  invitedEmail: text('invited_email').notNull(),
  invitedByApiKeyId: uuid('invited_by_api_key_id').references(() => apiKeys.id),
  customMessage: text('custom_message'),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  clickedAt: timestamp('clicked_at', { withTimezone: true }),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }),
  deviceId: uuid('device_id').references(() => devices.id),
  status: text('status').notNull().default('sent'),
});

export type DeploymentInvite = typeof deploymentInvites.$inferSelect;
export type NewDeploymentInvite = typeof deploymentInvites.$inferInsert;
```

- [ ] **Step 5: Export from `schema/index.ts`**

Add alongside existing re-exports:

```ts
export * from './partnerActivations';
export * from './deploymentInvites';
```

- [ ] **Step 6: Verify drift**

Run: `pnpm db:check-drift`
Expected: reports zero drift.

- [ ] **Step 7: Commit**

Stage: `apps/api/src/db/schema/`
Commit message: `feat(mcp-bootstrap): drizzle schema for partner_activations, deployment_invites, scope_state`

### Task 1.3: Add `partner_activations` and `deployment_invites` to RLS coverage allowlist

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (lines 46–49)

- [ ] **Step 1: Extend `PARTNER_TENANT_TABLES`**

```ts
const PARTNER_TENANT_TABLES: ReadonlyMap<string, string> = new Map<string, string>([
  ['partners', 'id'],
  ['partner_users', 'partner_id'],
  ['partner_activations', 'partner_id'],
  ['deployment_invites', 'partner_id'],
]);
```

- [ ] **Step 2: Run the contract test**

Run: `cd apps/api && pnpm test:rls`
Expected: assertions for the two new tables pass (policy exists, enabled, forced).

- [ ] **Step 3: Commit**

Commit message: `test(rls): cover partner_activations and deployment_invites`

### Task 1.4: Extract `createPartner()` service from `/register-partner`

**Files:**
- Create: `apps/api/src/services/partnerCreate.ts`
- Create: `apps/api/src/services/partnerCreate.test.ts`
- Modify: `apps/api/src/routes/auth/register.ts` (lines 158–288 — replace inline transaction with service call)

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/partnerCreate.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createPartner } from './partnerCreate';

vi.mock('../db', () => ({
  db: {
    transaction: vi.fn(async (cb: any) => cb({
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: 'mock-id' }]),
    })),
  },
}));

describe('createPartner', () => {
  it('inserts partner, admin user, default org, default site in a single transaction', async () => {
    const result = await createPartner({
      orgName: 'Acme',
      adminEmail: 'alex@acme.com',
      adminName: 'Alex',
      passwordHash: 'hashed',
      origin: { mcp: false },
    });
    expect(result.partnerId).toBeDefined();
    expect(result.orgId).toBeDefined();
    expect(result.adminUserId).toBeDefined();
    expect(result.siteId).toBeDefined();
  });

  it('tags partner with mcp_origin when origin.mcp is true', async () => {
    const result = await createPartner({
      orgName: 'Acme',
      adminEmail: 'alex@acme.com',
      adminName: 'Alex',
      passwordHash: null,
      origin: { mcp: true, ip: '1.2.3.4', userAgent: 'ClaudeAgent/1.0' },
    });
    expect(result.mcpOrigin).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd apps/api && pnpm test partnerCreate`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `createPartner()` by extracting the transaction from `register.ts`**

```ts
// apps/api/src/services/partnerCreate.ts
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../db';
import { partners, users, roles, partnerUsers, organizations, sites } from '../db/schema';

export interface CreatePartnerInput {
  orgName: string;
  adminEmail: string;
  adminName: string;
  passwordHash: string | null;
  origin: { mcp: false } | { mcp: true; ip?: string; userAgent?: string };
}

export interface CreatePartnerResult {
  partnerId: string;
  orgId: string;
  siteId: string;
  adminUserId: string;
  adminRoleId: string;
  mcpOrigin: boolean;
}

export async function createPartner(input: CreatePartnerInput): Promise<CreatePartnerResult> {
  return db.transaction(async (tx) => {
    const [partner] = await tx.insert(partners).values({
      name: input.orgName,
      slug: slugify(input.orgName),
      type: 'msp',
      plan: 'free',
      status: input.origin.mcp ? 'pending' : 'active',
      setupCompletedAt: new Date(),
      mcpOrigin: input.origin.mcp,
      mcpOriginIp: input.origin.mcp ? (input.origin.ip ?? null) : null,
      mcpOriginUserAgent: input.origin.mcp ? (input.origin.userAgent ?? null) : null,
    }).returning({ id: partners.id });

    const [adminRole] = await tx.insert(roles).values({
      partnerId: partner.id,
      name: 'Admin',
      isAdmin: true,
    }).returning({ id: roles.id });

    const [adminUser] = await tx.insert(users).values({
      email: input.adminEmail.toLowerCase(),
      name: input.adminName,
      passwordHash: input.passwordHash,
      emailVerified: false,
    }).returning({ id: users.id });

    await tx.insert(partnerUsers).values({
      partnerId: partner.id,
      userId: adminUser.id,
      roleId: adminRole.id,
    });

    const [org] = await tx.insert(organizations).values({
      partnerId: partner.id,
      name: input.orgName,
    }).returning({ id: organizations.id });

    const [site] = await tx.insert(sites).values({
      orgId: org.id,
      name: 'Default Site',
    }).returning({ id: sites.id });

    return {
      partnerId: partner.id,
      orgId: org.id,
      siteId: site.id,
      adminUserId: adminUser.id,
      adminRoleId: adminRole.id,
      mcpOrigin: input.origin.mcp,
    };
  });
}

export async function findRecentMcpPartnerByAdminEmail(
  email: string, orgName: string, since: Date
): Promise<{ id: string } | null> {
  const [row] = await db.select({ id: partners.id })
    .from(partners)
    .innerJoin(partnerUsers, eq(partnerUsers.partnerId, partners.id))
    .innerJoin(users, eq(users.id, partnerUsers.userId))
    .where(and(
      eq(partners.name, orgName),
      eq(partners.mcpOrigin, true),
      eq(users.email, email.toLowerCase()),
      gt(partners.createdAt, since),
    ))
    .limit(1);
  return row ?? null;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}
```

- [ ] **Step 4: Replace inline transaction in `register.ts`**

In `apps/api/src/routes/auth/register.ts` around lines 158–288, replace the `db.transaction(async (tx) => { ... })` block with:

```ts
const result = await createPartner({
  orgName: parsed.orgName,
  adminEmail: parsed.email,
  adminName: parsed.name,
  passwordHash,
  origin: { mcp: false },
});
```

Use `result.partnerId` / `result.orgId` / `result.adminUserId` downstream. Keep the rate-limit check (line 106), password hashing, `dispatchHook('registration', ...)` call, and refresh-cookie handling in the route as before.

- [ ] **Step 5: Run tests — both suites pass**

Run: `cd apps/api && pnpm test partnerCreate register`
Expected: both pass. The extraction is behavior-preserving.

- [ ] **Step 6: Commit**

Commit message: `refactor(auth): extract createPartner service for reuse by MCP bootstrap`

### Task 1.5: Business-email validator in `packages/shared`

**Files:**
- Create: `packages/shared/src/validators/businessEmail.ts`
- Create: `packages/shared/src/validators/businessEmail.test.ts`
- Modify: `packages/shared/package.json` (add `disposable-email-domains` dep)

- [ ] **Step 1: Install the disposable-email-domains package**

Run: `pnpm add -F @breeze/shared disposable-email-domains`

- [ ] **Step 2: Write the failing test**

```ts
// packages/shared/src/validators/businessEmail.test.ts
import { describe, it, expect } from 'vitest';
import { validateBusinessEmail } from './businessEmail';

describe('validateBusinessEmail', () => {
  it('accepts a business email', () => {
    expect(validateBusinessEmail('alex@acme.com')).toEqual({ ok: true });
  });

  it.each([
    'alex@gmail.com', 'alex@googlemail.com',
    'alex@outlook.com', 'alex@hotmail.com', 'alex@live.com',
    'alex@yahoo.com', 'alex@yahoo.co.uk',
    'alex@icloud.com', 'alex@me.com', 'alex@aol.com',
    'alex@proton.me', 'alex@protonmail.com',
    'alex@tutanota.com', 'alex@gmx.com',
    'alex@yandex.ru', 'alex@mail.ru',
    'alex@fastmail.com',
    'alex@qq.com', 'alex@163.com', 'alex@naver.com',
  ])('rejects free provider %s', (email) => {
    expect(validateBusinessEmail(email)).toEqual({ ok: false, reason: 'free_provider' });
  });

  it('rejects a disposable-email-domains entry', () => {
    expect(validateBusinessEmail('x@mailinator.com')).toEqual({ ok: false, reason: 'disposable' });
  });

  it('rejects malformed emails', () => {
    expect(validateBusinessEmail('not-an-email')).toEqual({ ok: false, reason: 'invalid_format' });
  });

  it('honors always_allow override', () => {
    expect(validateBusinessEmail('alex@gmail.com', { alwaysAllow: ['gmail.com'] })).toEqual({ ok: true });
  });

  it('honors always_block override', () => {
    expect(validateBusinessEmail('alex@acme.com', { alwaysBlock: ['acme.com'] })).toEqual({ ok: false, reason: 'blocked_override' });
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `cd packages/shared && pnpm test businessEmail`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `validateBusinessEmail()`**

```ts
// packages/shared/src/validators/businessEmail.ts
import disposable from 'disposable-email-domains';

const FREE_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.co.jp', 'yahoo.ca', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com',
  'proton.me', 'protonmail.com', 'pm.me',
  'tutanota.com', 'tuta.io',
  'gmx.com', 'gmx.net', 'gmx.de',
  'yandex.com', 'yandex.ru',
  'mail.ru',
  'fastmail.com', 'fastmail.fm',
  'zoho.com',
  'qq.com', '163.com', '126.com',
  'naver.com', 'daum.net',
]);
const DISPOSABLE = new Set<string>(disposable);

export interface BusinessEmailOptions {
  alwaysAllow?: string[];
  alwaysBlock?: string[];
}
export type BusinessEmailResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_format' | 'free_provider' | 'disposable' | 'blocked_override' };

export function validateBusinessEmail(email: string, opts: BusinessEmailOptions = {}): BusinessEmailResult {
  const match = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.exec(email.trim());
  if (!match) return { ok: false, reason: 'invalid_format' };
  const rawDomain = email.trim().split('@')[1].toLowerCase();
  let domain = rawDomain;
  try { domain = new URL(`http://${rawDomain}`).hostname; } catch { /* keep raw */ }

  const alwaysBlock = new Set((opts.alwaysBlock ?? []).map((d) => d.toLowerCase()));
  if (alwaysBlock.has(domain)) return { ok: false, reason: 'blocked_override' };

  const alwaysAllow = new Set((opts.alwaysAllow ?? []).map((d) => d.toLowerCase()));
  if (alwaysAllow.has(domain)) return { ok: true };

  if (DISPOSABLE.has(domain)) return { ok: false, reason: 'disposable' };
  if (FREE_PROVIDERS.has(domain)) return { ok: false, reason: 'free_provider' };

  return { ok: true };
}

export function loadOverridesFromEnv(): BusinessEmailOptions {
  const path = process.env.BUSINESS_EMAIL_ALLOW_OVERRIDES;
  if (!path) return {};
  try {
    const fs = require('node:fs');
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
    return {
      alwaysAllow: Array.isArray(parsed.always_allow) ? parsed.always_allow : [],
      alwaysBlock: Array.isArray(parsed.always_block) ? parsed.always_block : [],
    };
  } catch {
    return {};
  }
}
```

- [ ] **Step 5: Re-export from the package index**

Add `export * from './validators/businessEmail';` to `packages/shared/src/index.ts` (or validators barrel).

- [ ] **Step 6: Run tests**

Run: `cd packages/shared && pnpm test businessEmail`
Expected: all assertions pass.

- [ ] **Step 7: Commit**

Commit message: `feat(shared): validateBusinessEmail with free-provider + disposable lists`

### Task 1.6: Feature-flag plumbing + startup check

**Files:**
- Create: `apps/api/src/modules/mcpBootstrap/startupCheck.ts`
- Create: `apps/api/src/modules/mcpBootstrap/README.md`
- Modify: `.env.example`

- [ ] **Step 1: Write the startup check**

```ts
// apps/api/src/modules/mcpBootstrap/startupCheck.ts
const REQUIRED_ENVS = [
  'STRIPE_SECRET_KEY',
  'BREEZE_BILLING_URL',
  'EMAIL_PROVIDER_KEY',
  'PUBLIC_ACTIVATION_BASE_URL',
];

export function checkMcpBootstrapStartup(): void {
  const missing = REQUIRED_ENVS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `MCP_BOOTSTRAP_ENABLED is true but required env vars are missing: ${missing.join(', ')}. ` +
      `Either set these vars or set MCP_BOOTSTRAP_ENABLED=false.`
    );
  }
}
```

- [ ] **Step 2: Write the module README**

```markdown
# MCP Bootstrap Module

Feature-flagged module that lets an external AI agent provision a brand-new
Breeze tenant end-to-end via MCP. Default OFF.

**This module is for Breeze Cloud only.** Self-hosted deployments should
leave `MCP_BOOTSTRAP_ENABLED` unset.

## Required environment variables (when enabled)

| Var | Purpose |
|---|---|
| `MCP_BOOTSTRAP_ENABLED` | Set to `true` to enable. Default `false`. |
| `STRIPE_SECRET_KEY` | Stripe secret for SetupIntent creation via breeze-billing. |
| `BREEZE_BILLING_URL` | Base URL of the breeze-billing service. |
| `EMAIL_PROVIDER_KEY` | Whichever email provider is configured globally. |
| `PUBLIC_ACTIVATION_BASE_URL` | e.g. `https://us.2breeze.app`. |
| `BUSINESS_EMAIL_ALLOW_OVERRIDES` | Optional. Path to JSON file. |

## What gets registered when enabled

- MCP bootstrap tools: `create_tenant`, `verify_tenant`, `attach_payment_method` (unauthenticated).
- Authed MCP tools: `send_deployment_invites`, `configure_defaults`.
- Routes: `/activate/:token`, `/activate/complete/webhook`, `/i/:short_code`.
- `PAYMENT_REQUIRED` gate on the mutating authed tools + `set_alert_policy`.

## Flag-independent (always on)

- `delete_tenant` authed MCP tool.
- `validateBusinessEmail` shared validator.

See spec: `docs/superpowers/specs/2026-04-20-mcp-agent-deployable-setup-design.md`.
```

- [ ] **Step 3: Extend `.env.example`**

Append:

```
# MCP Bootstrap (SaaS-only — leave unset for self-hosted Breeze)
# Enables agent-driven tenant provisioning via MCP. See
# apps/api/src/modules/mcpBootstrap/README.md.
MCP_BOOTSTRAP_ENABLED=false
# BREEZE_BILLING_URL=https://billing.example.internal
# PUBLIC_ACTIVATION_BASE_URL=https://us.2breeze.app
# BUSINESS_EMAIL_ALLOW_OVERRIDES=/etc/breeze/email-overrides.json
```

- [ ] **Step 4: Commit**

Commit message: `chore(mcp-bootstrap): feature flag + startup-env check + README`

---

## Phase 2 — Unauthenticated bootstrap tools

### Task 2.1: Tool module scaffolding + types

**Files:**
- Create: `apps/api/src/modules/mcpBootstrap/types.ts`
- Create: `apps/api/src/modules/mcpBootstrap/index.ts` (skeleton — filled in as tools land)

- [ ] **Step 1: Define types**

```ts
// apps/api/src/modules/mcpBootstrap/types.ts
import type { z } from 'zod';

export interface BootstrapTool<TInput = unknown, TOutput = unknown> {
  definition: {
    name: string;
    description: string;
    inputSchema: z.ZodSchema<TInput>;
  };
  handler: (input: TInput, ctx: BootstrapContext) => Promise<TOutput>;
}

export interface BootstrapContext {
  ip: string | null;
  userAgent: string | null;
  region: 'us' | 'eu';
  apiKey?: {
    id: string;
    partnerId: string;
    defaultOrgId: string;
    partnerAdminEmail: string;
    scopeState: 'readonly' | 'full';
  };
}

export const BOOTSTRAP_TOOL_NAMES = ['create_tenant', 'verify_tenant', 'attach_payment_method'] as const;
export type BootstrapToolName = (typeof BOOTSTRAP_TOOL_NAMES)[number];

export class BootstrapError extends Error {
  constructor(public code: string, message: string, public remediation?: unknown) {
    super(message);
  }
}
```

- [ ] **Step 2: Module index (stub — completed in later tasks)**

```ts
// apps/api/src/modules/mcpBootstrap/index.ts
import type { BootstrapTool } from './types';
import { createTenantTool } from './tools/createTenant';
import { verifyTenantTool } from './tools/verifyTenant';
import { attachPaymentMethodTool } from './tools/attachPaymentMethod';
import { sendDeploymentInvitesTool } from './tools/sendDeploymentInvites';
import { configureDefaultsTool } from './tools/configureDefaults';
import { checkMcpBootstrapStartup } from './startupCheck';

export function initMcpBootstrap(): {
  unauthTools: BootstrapTool[];
  authTools: BootstrapTool[];
} {
  checkMcpBootstrapStartup();
  return {
    unauthTools: [createTenantTool, verifyTenantTool, attachPaymentMethodTool],
    authTools: [sendDeploymentInvitesTool, configureDefaultsTool],
  };
}

export { BOOTSTRAP_TOOL_NAMES, BootstrapError } from './types';
export { mountActivationRoutes } from './activationRoutes';
export { mountInviteLandingRoutes } from './inviteLandingRoutes';
```

This file will not compile until Tasks 2.2–2.4 and Tasks 3.2, 5.1–5.2 land. That is expected — commit at end of Phase 2.

### Task 2.2: `create_tenant` tool

**Files:**
- Create: `apps/api/src/modules/mcpBootstrap/tools/createTenant.ts`
- Create: `apps/api/src/modules/mcpBootstrap/tools/createTenant.test.ts`

- [ ] **Step 1: Failing test**

```ts
// apps/api/src/modules/mcpBootstrap/tools/createTenant.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../services/partnerCreate', () => ({
  createPartner: vi.fn().mockResolvedValue({
    partnerId: 'partner-1', orgId: 'org-1', siteId: 'site-1',
    adminUserId: 'user-1', adminRoleId: 'role-1', mcpOrigin: true,
  }),
  findRecentMcpPartnerByAdminEmail: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../services/rate-limit', () => ({
  rateLimiter: vi.fn().mockResolvedValue({ allowed: true, remaining: 1, resetAt: new Date() }),
}));
vi.mock('../../../services/redis', () => ({ getRedis: vi.fn().mockReturnValue(null) }));
vi.mock('../../../db', () => ({
  db: { insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }) },
}));
vi.mock('../../../services/activationEmail', () => ({
  sendActivationEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../services/auditEvents', () => ({ writeAuditEvent: vi.fn() }));

import { createTenantTool } from './createTenant';
import { createPartner, findRecentMcpPartnerByAdminEmail } from '../../../services/partnerCreate';
import { rateLimiter } from '../../../services/rate-limit';

const ctx = { ip: '1.2.3.4', userAgent: 'Claude', region: 'us' as const };

describe('create_tenant', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects free-provider emails', async () => {
    await expect(
      createTenantTool.handler({ org_name: 'Acme', admin_email: 'alex@gmail.com', admin_name: 'Alex', region: 'us' }, ctx)
    ).rejects.toMatchObject({ code: 'INVALID_EMAIL' });
  });

  it('rejects when region does not match endpoint', async () => {
    await expect(
      createTenantTool.handler({ org_name: 'Acme', admin_email: 'alex@acme.com', admin_name: 'Alex', region: 'eu' }, ctx)
    ).rejects.toMatchObject({ code: 'REGION_MISMATCH' });
  });

  it('rejects when per-IP rate limit exhausted', async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() });
    await expect(
      createTenantTool.handler({ org_name: 'Acme', admin_email: 'alex@acme.com', admin_name: 'Alex', region: 'us' }, ctx)
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('creates partner, inserts activation token, sends email, returns pending_email', async () => {
    const r = await createTenantTool.handler(
      { org_name: 'Acme', admin_email: 'alex@acme.com', admin_name: 'Alex', region: 'us' }, ctx
    );
    expect(r).toEqual({ tenant_id: 'partner-1', activation_status: 'pending_email' });
    expect(createPartner).toHaveBeenCalledWith(expect.objectContaining({
      orgName: 'Acme',
      adminEmail: 'alex@acme.com',
      origin: { mcp: true, ip: '1.2.3.4', userAgent: 'Claude' },
    }));
  });

  it('is idempotent within 1h on same email + org_name', async () => {
    vi.mocked(findRecentMcpPartnerByAdminEmail).mockResolvedValueOnce({ id: 'partner-1' });
    const r = await createTenantTool.handler(
      { org_name: 'Acme', admin_email: 'alex@acme.com', admin_name: 'Alex', region: 'us' }, ctx
    );
    expect(r.tenant_id).toBe('partner-1');
    expect(createPartner).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd apps/api && pnpm test createTenant`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `create_tenant`**

```ts
// apps/api/src/modules/mcpBootstrap/tools/createTenant.ts
import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { db } from '../../../db';
import { partnerActivations } from '../../../db/schema';
import { createPartner, findRecentMcpPartnerByAdminEmail } from '../../../services/partnerCreate';
import { rateLimiter } from '../../../services/rate-limit';
import { getRedis } from '../../../services/redis';
import { validateBusinessEmail, loadOverridesFromEnv } from '@breeze/shared';
import { sendActivationEmail } from '../../../services/activationEmail';
import { writeAuditEvent } from '../../../services/auditEvents';
import type { BootstrapTool } from '../types';
import { BootstrapError } from '../types';

const inputSchema = z.object({
  org_name: z.string().min(2).max(64),
  admin_email: z.string().email().max(254),
  admin_name: z.string().min(1).max(128),
  region: z.enum(['us', 'eu']),
});

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_WINDOW_MS = 60 * 60 * 1000;

export const createTenantTool: BootstrapTool<z.infer<typeof inputSchema>, { tenant_id: string; activation_status: 'pending_email' }> = {
  definition: {
    name: 'create_tenant',
    description: [
      'Create a brand-new Breeze tenant for an organization. This is the entry point for agent-driven Breeze setup.',
      'Accepts an org name, an admin email (must be a business email — free-provider and disposable-email domains are rejected), a name, and a region ("us" or "eu" — must match the MCP endpoint you are connected to).',
      'Returns a tenant_id. No API key is issued yet. An activation email is sent to the admin. Call verify_tenant(tenant_id) to poll for activation status; once the admin clicks the link, verify_tenant will return a readonly API key that you use for subsequent calls. To unlock mutations (invites, configuration), the admin must attach a payment method via attach_payment_method.',
      'If you get INVALID_EMAIL with reason "free_provider" or "disposable", ask the user for a business email.',
      'If you get REGION_MISMATCH, connect to the correct regional MCP endpoint.',
    ].join(' '),
    inputSchema,
  },
  handler: async (input, ctx) => {
    if (input.region !== ctx.region) {
      throw new BootstrapError('REGION_MISMATCH',
        `This endpoint serves region "${ctx.region}" but create_tenant was called with region "${input.region}".`);
    }

    const emailCheck = validateBusinessEmail(input.admin_email, loadOverridesFromEnv());
    if (!emailCheck.ok) {
      throw new BootstrapError('INVALID_EMAIL',
        `Admin email rejected: ${emailCheck.reason}. Use a business email (not gmail/outlook/etc., not disposable).`);
    }

    const redis = getRedis();
    const ip = ctx.ip ?? 'unknown';
    const domain = input.admin_email.split('@')[1].toLowerCase();
    if (!(await rateLimiter(redis, `mcp:bootstrap:ip:${ip}`, 3, 3600)).allowed)
      throw new BootstrapError('RATE_LIMITED', 'Per-IP rate limit exceeded.');
    if (!(await rateLimiter(redis, `mcp:bootstrap:domain:${domain}`, 5, 86400)).allowed)
      throw new BootstrapError('RATE_LIMITED', 'Per-email-domain rate limit exceeded.');
    if (!(await rateLimiter(redis, `mcp:bootstrap:global`, 200, 3600)).allowed)
      throw new BootstrapError('RATE_LIMITED', 'Global signup rate limit exceeded. Try again in an hour.');

    const since = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS);
    const existing = await findRecentMcpPartnerByAdminEmail(input.admin_email, input.org_name, since);
    if (existing) {
      await issueActivationToken(existing.id, input.admin_email);
      return { tenant_id: existing.id, activation_status: 'pending_email' };
    }

    const result = await createPartner({
      orgName: input.org_name,
      adminEmail: input.admin_email,
      adminName: input.admin_name,
      passwordHash: null,
      origin: { mcp: true, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined },
    });

    await issueActivationToken(result.partnerId, input.admin_email);

    writeAuditEvent(null as any, {
      actorType: 'system',
      action: 'partner.mcp_provisioned',
      resourceType: 'partner',
      resourceId: result.partnerId,
      result: 'success',
      metadata: { mcp_origin: true, tool_name: 'create_tenant', ip: ctx.ip, ua: ctx.userAgent },
    });

    return { tenant_id: result.partnerId, activation_status: 'pending_email' };
  },
};

async function issueActivationToken(partnerId: string, adminEmail: string): Promise<void> {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  await db.insert(partnerActivations).values({
    partnerId,
    tokenHash,
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });
  await sendActivationEmail({ to: adminEmail, rawToken, partnerId });
}
```

- [ ] **Step 4: Run tests — must pass**

Run: `cd apps/api && pnpm test createTenant`
Expected: all assertions pass.

### Task 2.3: `mintApiKey()` service + `verify_tenant` tool

**Files:**
- Create: `apps/api/src/services/apiKeys.ts`
- Create: `apps/api/src/services/apiKeys.test.ts`
- Create: `apps/api/src/modules/mcpBootstrap/tools/verifyTenant.ts`
- Create: `apps/api/src/modules/mcpBootstrap/tools/verifyTenant.test.ts`

- [ ] **Step 1: `mintApiKey` test**

```ts
// apps/api/src/services/apiKeys.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'key-1' }]) }) }) },
}));

import { mintApiKey } from './apiKeys';

describe('mintApiKey', () => {
  it('returns a brz_-prefixed raw key and an id', async () => {
    const r = await mintApiKey({ partnerId: 'p1', name: 'MCP Provisioning', scopeState: 'readonly', scopes: ['ai:read'], source: 'mcp_provisioning' });
    expect(r.id).toBe('key-1');
    expect(r.rawKey).toMatch(/^brz_/);
  });
});
```

- [ ] **Step 2: `mintApiKey` implementation**

```ts
// apps/api/src/services/apiKeys.ts
import { randomBytes, createHash } from 'node:crypto';
import { db } from '../db';
import { apiKeys } from '../db/schema';

export interface MintApiKeyInput {
  partnerId: string;
  name: string;
  scopeState: 'readonly' | 'full';
  scopes: string[];
  source: 'mcp_provisioning' | 'manual';
}

export async function mintApiKey(input: MintApiKeyInput): Promise<{ id: string; rawKey: string }> {
  const rawKey = `brz_${randomBytes(24).toString('hex')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 8);
  const [row] = await db.insert(apiKeys).values({
    orgId: input.partnerId, // partner-scoped; confirm column semantics during impl
    name: input.name,
    keyHash,
    keyPrefix,
    scopes: input.scopes,
    scopeState: input.scopeState,
    status: 'active',
  } as any).returning({ id: apiKeys.id });
  return { id: row.id, rawKey };
}
```

> **Implementation note:** the existing `apiKeys.orgId` column may semantically hold an organization ID, not a partner ID. During implementation, verify by reading the schema; if so, add a `partner_id UUID` column via a migration and update `mintApiKey` accordingly. Document the resolution in the commit message.

- [ ] **Step 3: `verify_tenant` failing test**

```ts
// apps/api/src/modules/mcpBootstrap/tools/verifyTenant.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db', () => ({ db: { select: vi.fn(), update: vi.fn() } }));
vi.mock('../../../services/rate-limit', () => ({ rateLimiter: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock('../../../services/redis', () => ({ getRedis: () => null }));
vi.mock('../../../services/apiKeys', () => ({
  mintApiKey: vi.fn().mockResolvedValue({ id: 'key-1', rawKey: 'brz_abc' }),
}));

import { verifyTenantTool } from './verifyTenant';
import { db } from '../../../db';

describe('verify_tenant', () => {
  beforeEach(() => vi.clearAllMocks());

  function mockPartnerAndActivation(partner: any, activation: any = null, existingKey: any = null) {
    const selectMock: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn(),
    };
    let call = 0;
    vi.mocked(db.select).mockImplementation(() => selectMock);
    selectMock.limit.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve([partner]);
      if (call === 2) return Promise.resolve(activation ? [activation] : []);
      if (call === 3) return Promise.resolve(existingKey ? [existingKey] : []);
      return Promise.resolve([]);
    });
  }

  it('returns pending_email when activation not consumed', async () => {
    mockPartnerAndActivation(
      { id: 'p1', emailVerifiedAt: null, paymentMethodAttachedAt: null },
      { expiresAt: new Date(Date.now() + 10000), consumedAt: null }
    );
    const r = await verifyTenantTool.handler({ tenant_id: 'p1' }, {} as any);
    expect(r).toEqual({ status: 'pending_email' });
  });

  it('returns expired when activation token lapsed', async () => {
    mockPartnerAndActivation(
      { id: 'p1', emailVerifiedAt: null, paymentMethodAttachedAt: null },
      { expiresAt: new Date(Date.now() - 10000), consumedAt: null }
    );
    const r = await verifyTenantTool.handler({ tenant_id: 'p1' }, {} as any);
    expect((r as any).status).toBe('expired');
  });

  it('returns pending_payment + readonly api key after email click', async () => {
    mockPartnerAndActivation(
      { id: 'p1', emailVerifiedAt: new Date(), paymentMethodAttachedAt: null },
      null,
      null
    );
    const r = await verifyTenantTool.handler({ tenant_id: 'p1' }, {} as any);
    expect(r).toMatchObject({ status: 'pending_payment', scope: 'readonly', api_key: expect.stringMatching(/^brz_/) });
  });

  it('returns active when payment attached and upgrades readonly key in place', async () => {
    mockPartnerAndActivation(
      { id: 'p1', emailVerifiedAt: new Date(), paymentMethodAttachedAt: new Date() },
      null,
      { id: 'key-1', scopeState: 'readonly' }
    );
    const updateMock = { set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) };
    vi.mocked(db.update).mockReturnValue(updateMock as any);
    const r = await verifyTenantTool.handler({ tenant_id: 'p1' }, {} as any);
    expect((r as any).status).toBe('active');
    expect((r as any).scope).toBe('full');
  });
});
```

- [ ] **Step 4: `verify_tenant` implementation**

```ts
// apps/api/src/modules/mcpBootstrap/tools/verifyTenant.ts
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../../db';
import { partners, partnerActivations, apiKeys } from '../../../db/schema';
import { rateLimiter } from '../../../services/rate-limit';
import { getRedis } from '../../../services/redis';
import { mintApiKey } from '../../../services/apiKeys';
import type { BootstrapTool } from '../types';
import { BootstrapError } from '../types';

const inputSchema = z.object({ tenant_id: z.string().uuid() });

export const verifyTenantTool: BootstrapTool = {
  definition: {
    name: 'verify_tenant',
    description: [
      'Check the activation status of a tenant created via create_tenant. Poll this tool (suggested interval: 5s) until { status: "active" }.',
      'Returns one of:',
      '- { status: "pending_email" } — admin has not clicked the link.',
      '- { status: "pending_payment", api_key, scope: "readonly" } — email verified; readonly key usable for read tools. Call attach_payment_method to unlock mutations.',
      '- { status: "active", api_key, scope: "full" } — fully activated. api_key value is stable across the pending_payment → active transition.',
      '- { status: "expired" } — activation window lapsed; call create_tenant again.',
      'The api_key is returned only on the first poll after it is minted; store it. Use as Authorization Bearer token for subsequent authenticated MCP calls.',
    ].join(' '),
    inputSchema,
  },
  handler: async (input) => {
    const rl = await rateLimiter(getRedis(), `mcp:verify:tenant:${input.tenant_id}`, 60, 60);
    if (!rl.allowed) throw new BootstrapError('RATE_LIMITED', 'Polling rate limit exceeded; slow down to 1 per second.');

    const [partner] = await db.select({
      id: partners.id,
      emailVerifiedAt: partners.emailVerifiedAt,
      paymentMethodAttachedAt: partners.paymentMethodAttachedAt,
    }).from(partners).where(eq(partners.id, input.tenant_id)).limit(1);
    if (!partner) throw new BootstrapError('UNKNOWN_TENANT', 'Tenant not found.');

    if (!partner.emailVerifiedAt) {
      const [latest] = await db.select({ expiresAt: partnerActivations.expiresAt, consumedAt: partnerActivations.consumedAt })
        .from(partnerActivations)
        .where(eq(partnerActivations.partnerId, partner.id))
        .orderBy(desc(partnerActivations.createdAt))
        .limit(1);
      if (latest && !latest.consumedAt && latest.expiresAt < new Date()) {
        return { status: 'expired', remediation: 'Call create_tenant again with the same admin_email to issue a new activation link.' };
      }
      return { status: 'pending_email' };
    }

    const [existingKey] = await db.select({ id: apiKeys.id, scopeState: apiKeys.scopeState })
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, partner.id), isNull(apiKeys.revokedAt as any)))
      .limit(1);

    let keyRow = existingKey;
    let rawKey: string | null = null;
    if (!keyRow) {
      const minted = await mintApiKey({
        partnerId: partner.id,
        name: 'MCP Provisioning',
        scopeState: partner.paymentMethodAttachedAt ? 'full' : 'readonly',
        scopes: ['ai:read', 'ai:write', 'ai:execute', 'ai:execute_admin'],
        source: 'mcp_provisioning',
      });
      keyRow = { id: minted.id, scopeState: partner.paymentMethodAttachedAt ? 'full' : 'readonly' };
      rawKey = minted.rawKey;
    }
    if (partner.paymentMethodAttachedAt && keyRow.scopeState === 'readonly') {
      await db.update(apiKeys).set({ scopeState: 'full' }).where(eq(apiKeys.id, keyRow.id));
      keyRow.scopeState = 'full';
    }

    return {
      status: partner.paymentMethodAttachedAt ? 'active' : 'pending_payment',
      api_key: rawKey,
      scope: keyRow.scopeState,
    };
  },
};
```

- [ ] **Step 5: Run tests**

Run: `cd apps/api && pnpm test verifyTenant apiKeys`
Expected: all pass.

### Task 2.4: `attach_payment_method` tool + billing client

**Files:**
- Create: `apps/api/src/services/breezeBillingClient.ts`
- Create: `apps/api/src/services/breezeBillingClient.test.ts`
- Create: `apps/api/src/modules/mcpBootstrap/tools/attachPaymentMethod.ts`
- Create: `apps/api/src/modules/mcpBootstrap/tools/attachPaymentMethod.test.ts`

- [ ] **Step 1: Billing client failing test**

```ts
// apps/api/src/services/breezeBillingClient.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createBreezeBillingClient } from './breezeBillingClient';

describe('breezeBillingClient', () => {
  it('creates a Stripe SetupIntent for a partner and returns the hosted URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ setup_url: 'https://stripe.example/setup/abc', customer_id: 'cus_123' }),
    });
    const client = createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock });
    const r = await client.createSetupIntent({ partnerId: 'p1', returnUrl: 'https://us.2breeze.app/activate/complete?partner=p1' });
    expect(r.setupUrl).toBe('https://stripe.example/setup/abc');
    expect(r.customerId).toBe('cus_123');
    expect(fetchMock).toHaveBeenCalledWith('http://billing.local/setup-intents', expect.objectContaining({ method: 'POST' }));
  });

  it('surfaces billing-service failures clearly', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'svc down' });
    const client = createBreezeBillingClient({ baseUrl: 'http://billing.local', fetch: fetchMock });
    await expect(client.createSetupIntent({ partnerId: 'p1', returnUrl: 'x' }))
      .rejects.toMatchObject({ code: 'BILLING_UNAVAILABLE' });
  });
});
```

- [ ] **Step 2: Billing client implementation**

```ts
// apps/api/src/services/breezeBillingClient.ts
export interface BreezeBillingClient {
  createSetupIntent(input: { partnerId: string; returnUrl: string }): Promise<{ setupUrl: string; customerId: string }>;
}

export class BillingError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function createBreezeBillingClient(opts: { baseUrl: string; fetch?: typeof fetch }): BreezeBillingClient {
  const doFetch = opts.fetch ?? fetch;
  return {
    async createSetupIntent({ partnerId, returnUrl }) {
      const res = await doFetch(`${opts.baseUrl}/setup-intents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ partner_id: partnerId, return_url: returnUrl }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new BillingError('BILLING_UNAVAILABLE', `Billing service returned ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = await res.json();
      return { setupUrl: json.setup_url, customerId: json.customer_id };
    },
  };
}

export function getBreezeBillingClient(): BreezeBillingClient {
  const baseUrl = process.env.BREEZE_BILLING_URL;
  if (!baseUrl) throw new Error('BREEZE_BILLING_URL not configured.');
  return createBreezeBillingClient({ baseUrl });
}
```

> **Prerequisite:** this assumes `POST /setup-intents` exists on the breeze-billing service, creating a Stripe Customer (if needed) and a SetupIntent, returning `{ setup_url, customer_id }`. If not yet present, add it in `/opt/breeze-billing` before deploying.

- [ ] **Step 3: `attach_payment_method` implementation**

```ts
// apps/api/src/modules/mcpBootstrap/tools/attachPaymentMethod.ts
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { partners } from '../../../db/schema';
import { getBreezeBillingClient } from '../../../services/breezeBillingClient';
import type { BootstrapTool } from '../types';
import { BootstrapError } from '../types';

const inputSchema = z.object({ tenant_id: z.string().uuid() });

export const attachPaymentMethodTool: BootstrapTool = {
  definition: {
    name: 'attach_payment_method',
    description: [
      'Return a Stripe Checkout URL (mode=setup) where the admin can attach a payment method for identity verification. No charge; this is KYC that unlocks tenant mutations.',
      'The user must open the returned setup_url in a browser and complete the Stripe flow. After completion the agent should resume polling verify_tenant until it returns { status: "active" }.',
      'Call this whenever a mutating tool returns PAYMENT_REQUIRED.',
    ].join(' '),
    inputSchema,
  },
  handler: async (input) => {
    const [partner] = await db.select({
      id: partners.id,
      emailVerifiedAt: partners.emailVerifiedAt,
      paymentMethodAttachedAt: partners.paymentMethodAttachedAt,
    }).from(partners).where(eq(partners.id, input.tenant_id)).limit(1);
    if (!partner) throw new BootstrapError('UNKNOWN_TENANT', 'Tenant not found.');
    if (!partner.emailVerifiedAt) throw new BootstrapError('EMAIL_NOT_VERIFIED', 'Call verify_tenant until status is pending_payment before calling attach_payment_method.');
    if (partner.paymentMethodAttachedAt) return { setup_url: null, already_attached: true };

    const base = process.env.PUBLIC_ACTIVATION_BASE_URL!;
    const billing = getBreezeBillingClient();
    const { setupUrl, customerId } = await billing.createSetupIntent({
      partnerId: partner.id,
      returnUrl: `${base}/activate/complete?partner=${partner.id}`,
    });
    await db.update(partners).set({ stripeCustomerId: customerId }).where(eq(partners.id, partner.id));
    return { setup_url: setupUrl, already_attached: false };
  },
};
```

- [ ] **Step 4: Tool test**

Mirror Tests in Task 2.3 — verify error surfaces (UNKNOWN_TENANT, EMAIL_NOT_VERIFIED, already_attached passthrough) and that the billing client is called with the correct return URL.

- [ ] **Step 5: Run tests**

Run: `cd apps/api && pnpm test attachPaymentMethod breezeBillingClient`

- [ ] **Step 6: Commit Phase 2 tools**

Stage: `apps/api/src/modules/mcpBootstrap/ apps/api/src/services/breezeBillingClient.ts apps/api/src/services/breezeBillingClient.test.ts apps/api/src/services/apiKeys.ts apps/api/src/services/apiKeys.test.ts`
Commit message: `feat(mcp-bootstrap): unauth create_tenant + verify_tenant + attach_payment_method tools`

### Task 2.5: Wire bootstrap module into `mcpServer.ts` with auth-aware tool listing

**Files:**
- Modify: `apps/api/src/routes/mcpServer.ts`

- [ ] **Step 1: Add module load helper near top of file**

```ts
import { envFlag } from '../utils/env';

const MCP_BOOTSTRAP_ENABLED = envFlag('MCP_BOOTSTRAP_ENABLED', false);

let bootstrapModule: Awaited<ReturnType<typeof loadBootstrap>> | null = null;
async function loadBootstrap() {
  if (!MCP_BOOTSTRAP_ENABLED) return null;
  const mod = await import('../modules/mcpBootstrap');
  return mod.initMcpBootstrap();
}
loadBootstrap().then((b) => { bootstrapModule = b; });

import { BOOTSTRAP_TOOL_NAMES } from '../modules/mcpBootstrap/types';
```

- [ ] **Step 2: Modify auth middleware (line 60 area) to carve out bootstrap calls**

```ts
app.use('/mcp/*', async (c, next) => {
  const hasKey = Boolean(c.req.header('authorization'));
  if (hasKey) return apiKeyAuthMiddleware(c, next);
  if (!bootstrapModule) {
    return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Authorization required' } }, 401);
  }
  const body = await c.req.raw.clone().json().catch(() => null);
  if (!body) return c.json({ jsonrpc: '2.0', error: { code: -32600 } }, 400);
  if (body.method === 'tools/list') return next();
  if (body.method === 'tools/call' && BOOTSTRAP_TOOL_NAMES.includes(body.params?.name)) return next();
  return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Authorization required' } }, 401);
});
```

- [ ] **Step 3: Update `handleToolsList()` (lines 306–359) to branch on auth**

```ts
async function handleToolsList(c: Context) {
  const apiKey = c.get('apiKey');
  if (!apiKey) {
    if (!bootstrapModule) return [];
    return bootstrapModule.unauthTools.map(toDefinition);
  }
  const all = [...aiTools.values()].filter((t) => !BOOTSTRAP_TOOL_NAMES.includes(t.definition.name as any));
  // existing scope/tier filtering unchanged
  return all.filter((t) => existingScopeAndTierFilter(t, apiKey));
}
```

- [ ] **Step 4: Update `handleToolsCall()` (lines 365–439) to dispatch bootstrap tools**

```ts
const { name, arguments: args } = params;
if (BOOTSTRAP_TOOL_NAMES.includes(name as any)) {
  if (!bootstrapModule) throw mcpError(-32601, 'Tool not available.');
  if (c.get('apiKey')) throw mcpError(-32001, 'already_authenticated: bootstrap tools are only available pre-activation.');
  const tool = bootstrapModule.unauthTools.find((t) => t.definition.name === name);
  if (!tool) throw mcpError(-32601);
  const ctx = {
    ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: c.req.header('user-agent') ?? null,
    region: (process.env.BREEZE_REGION as 'us' | 'eu') ?? 'us',
  };
  try {
    return await tool.handler(args, ctx);
  } catch (err: any) {
    if (err?.code) throw mcpError(-32000, err.message, { code: err.code, remediation: err.remediation });
    throw err;
  }
}
```

- [ ] **Step 5: Add `mcpServer` regression tests for flag on/off**

Tests assert that flag-off unauth'd requests → 401 and flag-on unauth'd requests → bootstrap tool list with exactly three names.

- [ ] **Step 6: Run tests + commit**

Run: `cd apps/api && pnpm test mcpServer`
Commit message: `feat(mcp): auth-aware tools/list + bootstrap carve-out gated by MCP_BOOTSTRAP_ENABLED`

---

## Phase 3 — Activation page, email, Stripe webhook

### Task 3.1: Activation email template and sender

**Files:**
- Create: `apps/api/src/services/activationEmail.ts`
- Create: `apps/api/src/services/activationEmail.test.ts`

- [ ] **Step 1: Builder test**

```ts
import { describe, it, expect } from 'vitest';
import { buildActivationEmail } from './activationEmail';

describe('buildActivationEmail', () => {
  it('includes activation URL and org name', () => {
    const { subject, html, text } = buildActivationEmail({
      activationUrl: 'https://us.2breeze.app/activate/abc',
      orgName: 'Acme',
    });
    expect(subject).toContain('Activate');
    expect(html).toContain('https://us.2breeze.app/activate/abc');
    expect(text).toContain('https://us.2breeze.app/activate/abc');
    expect(html).toContain('Acme');
  });
});
```

- [ ] **Step 2: Implementation**

```ts
// apps/api/src/services/activationEmail.ts
import { eq } from 'drizzle-orm';
import { getEmailService } from './email';
import { db } from '../db';
import { partners } from '../db/schema';

export interface BuildActivationEmailInput { activationUrl: string; orgName: string; }

export function buildActivationEmail({ activationUrl, orgName }: BuildActivationEmailInput) {
  const subject = `Activate your Breeze tenant for ${orgName}`;
  const text = `Welcome to Breeze!\n\nClick the link below to activate ${orgName}'s tenant (link valid 24 hours):\n\n${activationUrl}\n\nAfter clicking, you'll be asked to attach a payment method for identity verification (no charge for free tier).\n\n— Breeze`;
  const html = `<p>Welcome to <strong>Breeze</strong>!</p><p>Click the link below to activate <strong>${escape(orgName)}</strong>'s tenant (link valid 24 hours):</p><p><a href="${activationUrl}">${activationUrl}</a></p><p>After clicking, you'll be asked to attach a payment method for identity verification (no charge for free tier).</p><p>— Breeze</p>`;
  return { subject, html, text };
}

function escape(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]!));
}

export async function sendActivationEmail({ to, rawToken, partnerId }: { to: string; rawToken: string; partnerId: string }) {
  const base = process.env.PUBLIC_ACTIVATION_BASE_URL!;
  const [partner] = await db.select({ name: partners.name }).from(partners).where(eq(partners.id, partnerId)).limit(1);
  const tmpl = buildActivationEmail({ activationUrl: `${base}/activate/${rawToken}`, orgName: partner?.name ?? 'your organization' });
  const svc = getEmailService();
  if (!svc) throw new Error('Email service not configured');
  await svc.sendEmail({ to, ...tmpl });
}
```

- [ ] **Step 3: Run tests + commit**

Commit message: `feat(mcp-bootstrap): activation email builder + sender`

### Task 3.2: Activation routes (`/activate/:token` + Stripe webhook)

**Files:**
- Create: `apps/api/src/modules/mcpBootstrap/activationRoutes.ts`
- Create: `apps/api/src/modules/mcpBootstrap/activationRoutes.test.ts`

- [ ] **Step 1: Write failing tests**

Tests cover:
- `GET /activate/:token` marks activation consumed + partner.emailVerifiedAt on first valid click → redirects to `/activate/:token?status=email_verified`.
- Expired token → 410.
- Already-consumed token → 410.
- Invalid token → 404.
- Per-token rate-limit (10/hour) returns 429.
- `POST /activate/complete/webhook` with valid Stripe signature and `setup_intent.succeeded` → marks `paymentMethodAttachedAt` + upgrades readonly key to full.
- Webhook with bad signature → 400.

- [ ] **Step 2: Implementation**

```ts
// apps/api/src/modules/mcpBootstrap/activationRoutes.ts
import type { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { db } from '../../db';
import { partners, partnerActivations, apiKeys, users, partnerUsers } from '../../db/schema';
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis';
import { writeAuditEvent } from '../../services/auditEvents';
import { getBreezeBillingClient } from '../../services/breezeBillingClient';

export function mountActivationRoutes(app: Hono) {
  app.get('/activate/:token', async (c) => {
    const raw = c.req.param('token');
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    const rl = await rateLimiter(getRedis(), `mcp:activate:token:${tokenHash}`, 10, 3600);
    if (!rl.allowed) return c.text('Too many attempts', 429);

    const [row] = await db.select().from(partnerActivations).where(eq(partnerActivations.tokenHash, tokenHash)).limit(1);
    if (!row) return c.text('Invalid activation link', 404);
    if (row.consumedAt) return c.text('This link has already been used.', 410);
    if (row.expiresAt < new Date()) return c.text('This link has expired. Ask your agent to call create_tenant again.', 410);

    await db.transaction(async (tx) => {
      await tx.update(partnerActivations).set({ consumedAt: new Date() }).where(eq(partnerActivations.id, row.id));
      await tx.update(partners).set({ emailVerifiedAt: new Date() }).where(eq(partners.id, row.partnerId));
      const [adminLink] = await tx.select({ userId: partnerUsers.userId })
        .from(partnerUsers).where(eq(partnerUsers.partnerId, row.partnerId)).limit(1);
      if (adminLink) await tx.update(users).set({ emailVerified: true }).where(eq(users.id, adminLink.userId));
    });
    writeAuditEvent(null as any, {
      actorType: 'system', action: 'partner.activation_completed',
      resourceType: 'partner', resourceId: row.partnerId, result: 'success',
    });

    return c.redirect(`/activate/${raw}?status=email_verified`);
  });

  app.post('/activate/setup-intent', async (c) => {
    const { token } = await c.req.json();
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const [row] = await db.select().from(partnerActivations).where(eq(partnerActivations.tokenHash, tokenHash)).limit(1);
    if (!row || !row.consumedAt) return c.json({ error: 'invalid_state' }, 400);
    const billing = getBreezeBillingClient();
    const { setupUrl, customerId } = await billing.createSetupIntent({
      partnerId: row.partnerId,
      returnUrl: `${process.env.PUBLIC_ACTIVATION_BASE_URL}/activate/complete`,
    });
    await db.update(partners).set({ stripeCustomerId: customerId }).where(eq(partners.id, row.partnerId));
    return c.json({ setup_url: setupUrl });
  });

  app.post('/activate/complete/webhook', async (c) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' });
    const sig = c.req.header('stripe-signature');
    if (!sig) return c.text('missing signature', 400);
    const body = await c.req.text();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
    } catch (err: any) {
      return c.text(`bad signature: ${err.message}`, 400);
    }
    if (event.type === 'setup_intent.succeeded') {
      const si = event.data.object as Stripe.SetupIntent;
      const customerId = typeof si.customer === 'string' ? si.customer : si.customer?.id;
      if (!customerId) return c.text('no customer', 400);
      const [partner] = await db.select({ id: partners.id }).from(partners).where(eq(partners.stripeCustomerId, customerId)).limit(1);
      if (!partner) return c.text('unknown customer', 404);
      await db.transaction(async (tx) => {
        await tx.update(partners).set({ paymentMethodAttachedAt: new Date() }).where(eq(partners.id, partner.id));
        await tx.update(apiKeys).set({ scopeState: 'full' })
          .where(and(eq(apiKeys.orgId, partner.id), eq(apiKeys.scopeState, 'readonly')));
      });
      writeAuditEvent(null as any, {
        actorType: 'system', action: 'partner.payment_method_attached',
        resourceType: 'partner', resourceId: partner.id, result: 'success',
      });
    }
    return c.text('ok');
  });
}
```

- [ ] **Step 3: Wire into `apps/api/src/index.ts` conditionally**

```ts
if (process.env.MCP_BOOTSTRAP_ENABLED === 'true') {
  const { mountActivationRoutes } = await import('./modules/mcpBootstrap');
  mountActivationRoutes(app);
}
```

- [ ] **Step 4: Run tests + commit**

Run: `cd apps/api && pnpm test activationRoutes`
Commit message: `feat(mcp-bootstrap): activation route + Stripe SetupIntent webhook`

### Task 3.3: Web activation page

**Files:**
- Create: `apps/web/src/pages/activate/[token].astro`
- Create: `apps/web/src/pages/activate/complete.astro`
- Create: `apps/web/src/components/activate/ActivateTokenPage.tsx`
- Create: `apps/web/src/components/activate/ActivationComplete.tsx`

- [ ] **Step 1: Astro wrapper for `[token].astro`**

```astro
---
import AuthLayout from '../../layouts/AuthLayout.astro';
import { ActivateTokenPage } from '../../components/activate/ActivateTokenPage';

const { token } = Astro.params;
const status = Astro.url.searchParams.get('status') ?? 'pending';
---
<AuthLayout title="Activate your Breeze tenant">
  <ActivateTokenPage client:load token={token!} initialStatus={status} />
</AuthLayout>
```

- [ ] **Step 2: `ActivateTokenPage.tsx`**

```tsx
import { useState } from 'react';

export function ActivateTokenPage({ token, initialStatus }: { token: string; initialStatus: string }) {
  const [status, setStatus] = useState<'pending' | 'email_verified' | 'payment_redirecting'>(initialStatus as any);

  async function onAttachPayment() {
    setStatus('payment_redirecting');
    const res = await fetch('/activate/setup-intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) { alert('Could not start payment setup.'); return; }
    const { setup_url } = await res.json();
    window.location.href = setup_url;
  }

  if (status === 'pending') return <div>Verifying your email…</div>;

  if (status === 'email_verified') {
    return (
      <div className="max-w-md mx-auto py-16">
        <h1 className="text-2xl font-semibold mb-2">Email verified ✓</h1>
        <p className="mb-6">Add a payment method to finish activating your tenant. This is for identity verification — no charge for the free tier (25 devices).</p>
        <button onClick={onAttachPayment} className="btn btn-primary">Add payment method</button>
      </div>
    );
  }
  return <div>Redirecting to Stripe…</div>;
}
```

- [ ] **Step 3: `complete.astro` + `ActivationComplete.tsx`**

```astro
---
import AuthLayout from '../../layouts/AuthLayout.astro';
import { ActivationComplete } from '../../components/activate/ActivationComplete';
---
<AuthLayout title="Activation complete">
  <ActivationComplete client:load />
</AuthLayout>
```

```tsx
export function ActivationComplete() {
  return (
    <div className="max-w-md mx-auto py-16">
      <h1 className="text-2xl font-semibold mb-2">You're all set ✓</h1>
      <p>Return to your agent chat — it will detect activation and continue from there.</p>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

Commit message: `feat(web): activation + activation-complete pages`

---

## Phase 4 — Readonly scope enforcement + payment gate decorator

### Task 4.1: Readonly-scope backstop in `mcpServer.ts`

**Files:**
- Modify: `apps/api/src/routes/mcpServer.ts` (after auth, before tool dispatch)

- [ ] **Step 1: Add scope check**

```ts
const apiKey = c.get('apiKey');
const tool = aiTools.get(toolName);
if (apiKey?.scopeState === 'readonly' && toolTier(tool) >= 2) {
  return c.json({
    jsonrpc: '2.0',
    id: body.id,
    error: {
      code: -32001,
      message: 'PAYMENT_REQUIRED',
      data: { code: 'PAYMENT_REQUIRED', remediation: { tool: 'attach_payment_method', args: { tenant_id: apiKey.partnerId } } },
    },
  }, 402);
}
```

- [ ] **Step 2: Test tier-1 still works with readonly, tier-2+ returns 402**

- [ ] **Step 3: Commit**

Commit message: `feat(mcp): readonly scope backstop on tier-2+ tools`

### Task 4.2: `requirePaymentMethod()` decorator

**Files:**
- Create: `apps/api/src/modules/mcpBootstrap/paymentGate.ts`
- Create: `apps/api/src/modules/mcpBootstrap/paymentGate.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { requirePaymentMethod, PaymentRequiredError } from './paymentGate';

vi.mock('../../db', () => ({ db: { select: vi.fn() } }));

describe('requirePaymentMethod', () => {
  it('throws PAYMENT_REQUIRED when payment_method_attached_at is null', async () => {
    const { db } = await import('../../db');
    (db.select as any).mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ paid: null }]) }) }),
    });
    const wrapped = requirePaymentMethod(async () => 'ok');
    await expect(wrapped({}, { apiKey: { partnerId: 'p1' } } as any))
      .rejects.toBeInstanceOf(PaymentRequiredError);
  });

  it('passes through when payment attached', async () => {
    const { db } = await import('../../db');
    (db.select as any).mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ paid: new Date() }]) }) }),
    });
    const wrapped = requirePaymentMethod(async () => 'ok');
    await expect(wrapped({}, { apiKey: { partnerId: 'p1' } } as any)).resolves.toBe('ok');
  });
});
```

- [ ] **Step 2: Implementation**

```ts
// apps/api/src/modules/mcpBootstrap/paymentGate.ts
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { partners } from '../../db/schema';

export class PaymentRequiredError extends Error {
  code = 'PAYMENT_REQUIRED';
  remediation: { tool: string; args: { tenant_id: string } };
  constructor(public partnerId: string) {
    super('This action requires a payment method on file (identity verification, no charge for free tier).');
    this.remediation = { tool: 'attach_payment_method', args: { tenant_id: partnerId } };
  }
}

export function requirePaymentMethod<I, O>(handler: (input: I, ctx: any) => Promise<O>) {
  return async (input: I, ctx: any): Promise<O> => {
    const partnerId = ctx.apiKey?.partnerId;
    if (!partnerId) throw new Error('No partner in context');
    const [p] = await db.select({ paid: partners.paymentMethodAttachedAt })
      .from(partners).where(eq(partners.id, partnerId)).limit(1);
    if (!p?.paid) throw new PaymentRequiredError(partnerId);
    return handler(input, ctx);
  };
}
```

- [ ] **Step 3: Run test + commit**

Commit message: `feat(mcp-bootstrap): requirePaymentMethod tool decorator`

---

## Phase 5 — `send_deployment_invites` + invite landing page

### Task 5.1: `send_deployment_invites` tool + email builder

**Files:**
- Create: `apps/api/src/services/deploymentInviteEmail.ts`
- Create: `apps/api/src/modules/mcpBootstrap/tools/sendDeploymentInvites.ts`
- Create: `apps/api/src/modules/mcpBootstrap/tools/sendDeploymentInvites.test.ts`

- [ ] **Step 1: Email builder**

```ts
// apps/api/src/services/deploymentInviteEmail.ts
export function buildDeploymentInviteEmail(input: {
  orgName: string; adminEmail: string; installUrl: string; customMessage?: string;
}) {
  const subject = `[${input.orgName}] Install your device monitoring agent`;
  const safeMsg = input.customMessage ? input.customMessage.replace(/<[^>]+>/g, '').slice(0, 500) : '';
  const text = [
    `Hi,`, ``,
    `Your IT admin (${input.adminEmail}) has set up Breeze, a monitoring agent that keeps your device secure and performant.`,
    ``,
    `→ Install now: ${input.installUrl}`, ``,
    `The install takes <60 seconds and detects your OS automatically. Mac, Windows, and Linux supported. Admin password will be required on your machine.`,
    safeMsg ? `\n${safeMsg}` : '',
    ``, `Questions? Reply to this email.`, ``,
    `— Breeze, for ${input.orgName}`,
  ].join('\n');
  const html = `<p>Hi,</p><p>Your IT admin (${input.adminEmail}) has set up <strong>Breeze</strong>, a monitoring agent that keeps your device secure and performant.</p><p><a href="${input.installUrl}">→ Install now</a></p><p>The install takes &lt;60 seconds and detects your OS automatically.</p>${safeMsg ? `<p>${safeMsg}</p>` : ''}<p>Questions? Reply to this email.</p><p>— Breeze, for ${input.orgName}</p>`;
  return { subject, html, text };
}
```

- [ ] **Step 2: Tool test**

```ts
// apps/api/src/modules/mcpBootstrap/tools/sendDeploymentInvites.test.ts
// Cover: rejects when payment not attached (PaymentRequiredError);
//        rejects when emails.length > 25 (zod input schema);
//        dedupes recipients invited in last 24h;
//        mints a child enrollment key per recipient + sends one email + inserts one deployment_invites row per recipient;
//        enforces per-tenant invite rate limit (50/hour).
```

- [ ] **Step 3: Tool implementation**

```ts
// apps/api/src/modules/mcpBootstrap/tools/sendDeploymentInvites.ts
import { z } from 'zod';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../../../db';
import { deploymentInvites, partners } from '../../../db/schema';
import { mintChildEnrollmentKey, allocateShortCode } from '../../../routes/enrollmentKeys';
import { requirePaymentMethod } from '../paymentGate';
import { rateLimiter } from '../../../services/rate-limit';
import { getRedis } from '../../../services/redis';
import { buildDeploymentInviteEmail } from '../../../services/deploymentInviteEmail';
import { getEmailService } from '../../../services/email';
import { writeAuditEvent } from '../../../services/auditEvents';
import type { BootstrapTool } from '../types';

const FREE_TIER_DEVICE_CAP = 25;
const inputSchema = z.object({
  emails: z.array(z.string().email().max(254)).min(1).max(FREE_TIER_DEVICE_CAP),
  custom_message: z.string().max(500).optional(),
  os_targets: z.enum(['win', 'mac', 'linux', 'auto']).optional().default('auto'),
});

const handler = async (input: z.infer<typeof inputSchema>, ctx: any) => {
  const partnerId = ctx.apiKey.partnerId;
  const rl = await rateLimiter(getRedis(), `mcp:invites:tenant:${partnerId}`, 50, 3600);
  if (!rl.allowed) throw Object.assign(new Error('invite rate limit exceeded'), { code: 'RATE_LIMITED' });

  const since = new Date(Date.now() - 86400_000);
  const recent = await db.select({ email: deploymentInvites.invitedEmail })
    .from(deploymentInvites)
    .where(and(eq(deploymentInvites.partnerId, partnerId), gt(deploymentInvites.sentAt, since)));
  const recentSet = new Set(recent.map((r) => r.email.toLowerCase()));
  const toSend = input.emails.filter((e) => !recentSet.has(e.toLowerCase()));
  if (toSend.length === 0) {
    return { invites_sent: 0, invite_ids: [], skipped_duplicates: input.emails.length };
  }

  const [partner] = await db.select({ name: partners.name }).from(partners).where(eq(partners.id, partnerId)).limit(1);
  const adminEmail = ctx.apiKey.partnerAdminEmail ?? 'admin';
  const emailSvc = getEmailService();
  const inviteIds: string[] = [];

  for (const email of toSend) {
    const child = await mintChildEnrollmentKey({ partnerId, expiresInSeconds: 7 * 86400, maxUsage: 1 });
    const shortCode = await allocateShortCode(child.id);
    const installUrl = `${process.env.PUBLIC_ACTIVATION_BASE_URL}/i/${shortCode}`;
    const tmpl = buildDeploymentInviteEmail({
      orgName: partner.name, adminEmail, installUrl, customMessage: input.custom_message,
    });
    await emailSvc!.sendEmail({ to: email, ...tmpl });

    const [row] = await db.insert(deploymentInvites).values({
      partnerId, orgId: child.orgId, enrollmentKeyId: child.id,
      invitedEmail: email.toLowerCase(), invitedByApiKeyId: ctx.apiKey.id,
      customMessage: input.custom_message, status: 'sent',
    }).returning({ id: deploymentInvites.id });
    inviteIds.push(row.id);

    writeAuditEvent(ctx, {
      actorType: 'api_key', actorId: ctx.apiKey.id,
      action: 'invite.sent', resourceType: 'deployment_invite', resourceId: row.id,
      result: 'success', metadata: { mcp_origin: true, recipient_domain: email.split('@')[1] },
    });
  }

  return { invites_sent: inviteIds.length, invite_ids: inviteIds, skipped_duplicates: input.emails.length - inviteIds.length };
};

export const sendDeploymentInvitesTool: BootstrapTool = {
  definition: {
    name: 'send_deployment_invites',
    description: [
      'Email each listed staff member a one-click installer link for their operating system. Each link auto-enrolls their device into this tenant.',
      'Call this after verify_tenant returns active. Requires a payment method on file; if you get PAYMENT_REQUIRED, call attach_payment_method first.',
      'Maximum 25 invites per call (free-tier device cap). Recipients invited in the last 24h are silently deduplicated.',
      'Poll get_fleet_status to see devices come online as staff install.',
    ].join(' '),
    inputSchema,
  },
  handler: requirePaymentMethod(handler),
};
```

> **Prerequisite:** `mintChildEnrollmentKey` and `allocateShortCode` must be exported from `apps/api/src/routes/enrollmentKeys.ts`. If currently internal, extract to module-level exports without changing behavior (small refactor).

- [ ] **Step 4: Run tests + commit**

Commit message: `feat(mcp-bootstrap): send_deployment_invites tool with child key minting + email`

### Task 5.2: `/i/:short_code` OS-detecting landing route

**Files:**
- Create: `apps/api/src/modules/mcpBootstrap/inviteLandingRoutes.ts`
- Create: `apps/api/src/modules/mcpBootstrap/inviteLandingRoutes.test.ts`

- [ ] **Step 1: Route implementation**

```ts
// apps/api/src/modules/mcpBootstrap/inviteLandingRoutes.ts
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { deploymentInvites } from '../../db/schema';
import { redeemShortCode } from '../../routes/enrollmentKeys';
import { buildWindowsInstallerZip, buildMacosInstallerZip } from '../../services/installerBuilder';

function detectOS(ua: string | null): 'win' | 'mac' | 'linux' | 'unknown' {
  if (!ua) return 'unknown';
  if (/Win/i.test(ua)) return 'win';
  if (/Mac/i.test(ua)) return 'mac';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return 'unknown';
}

export function mountInviteLandingRoutes(app: Hono) {
  app.get('/i/:shortCode', async (c) => {
    const sc = c.req.param('shortCode');
    const key = await redeemShortCode(sc);
    if (!key) return c.text('This install link is invalid or has already been used.', 404);
    await db.update(deploymentInvites)
      .set({ status: 'clicked', clickedAt: new Date() })
      .where(eq(deploymentInvites.enrollmentKeyId, key.id));
    const os = detectOS(c.req.header('user-agent'));
    return c.html(renderLanding({ os, shortCode: sc }));
  });

  app.get('/i/:shortCode/download/:os', async (c) => {
    const sc = c.req.param('shortCode');
    const osParam = c.req.param('os');
    const key = await redeemShortCode(sc);
    if (!key) return c.text('invalid', 404);
    const builderInput = {
      serverUrl: process.env.PUBLIC_ACTIVATION_BASE_URL!,
      enrollmentKey: key.rawKey,
      enrollmentSecret: key.secret,
      siteId: key.siteId,
    };
    const buf = osParam === 'win'
      ? await buildWindowsInstallerZip(Buffer.alloc(0), builderInput)
      : await buildMacosInstallerZip(Buffer.alloc(0), builderInput);
    return new Response(buf, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename=breeze-agent-${osParam}.zip`,
      },
    });
  });
}

function renderLanding({ os, shortCode }: { os: string; shortCode: string }): string {
  const primary = os === 'win' ? 'Download for Windows' : os === 'mac' ? 'Download for macOS' : 'Download for Linux';
  const primaryHref = `/i/${shortCode}/download/${os === 'unknown' ? 'win' : os}`;
  return `<!doctype html><html><body style="font-family:system-ui;max-width:480px;margin:4rem auto;padding:0 1rem">
    <h1>Install Breeze</h1>
    <p>Click below to download and install the Breeze monitoring agent for your device.</p>
    <a href="${primaryHref}" style="display:inline-block;background:#111;color:#fff;padding:0.75rem 1.5rem;border-radius:6px;text-decoration:none">${primary}</a>
    <p style="margin-top:2rem;color:#555;font-size:0.9rem">Other OSes:
      <a href="/i/${shortCode}/download/win">Windows</a> •
      <a href="/i/${shortCode}/download/mac">macOS</a> •
      <a href="/i/${shortCode}/download/linux">Linux</a>
    </p>
  </body></html>`;
}
```

- [ ] **Step 2: Ensure `redeemShortCode` exported from `enrollmentKeys.ts`**

If currently internal, extract to module-level export (no behavior change).

- [ ] **Step 3: Wire route into `apps/api/src/index.ts` conditionally**

```ts
if (process.env.MCP_BOOTSTRAP_ENABLED === 'true') {
  const { mountActivationRoutes, mountInviteLandingRoutes } = await import('./modules/mcpBootstrap');
  mountActivationRoutes(app);
  mountInviteLandingRoutes(app);
}
```

- [ ] **Step 4: Test + commit**

Commit message: `feat(mcp-bootstrap): /i/:short_code OS-detecting installer landing`

### Task 5.3: Match invite enrollment on first device heartbeat

**Files:**
- Modify: `apps/api/src/routes/agents/heartbeat.ts` (or the first-heartbeat handler)

- [ ] **Step 1: Add one-shot update on first heartbeat**

At the end of the first-heartbeat path, after the `devices` row is upserted:

```ts
await db.update(deploymentInvites)
  .set({ status: 'enrolled', enrolledAt: new Date(), deviceId: device.id })
  .where(and(
    eq(deploymentInvites.enrollmentKeyId, device.enrollmentKeyId),
    isNull(deploymentInvites.enrolledAt),
  ));
```

- [ ] **Step 2: Test + commit**

Commit message: `feat(mcp-bootstrap): match deployment_invites to enrolled device on first heartbeat`

---

## Phase 6 — `configure_defaults`, fleet_status extension, audit event surfacing

### Task 6.1: `configure_defaults` opinionated-baseline wrapper

**Files:**
- Create: `apps/api/src/modules/mcpBootstrap/tools/configureDefaults.ts`
- Create: `apps/api/src/modules/mcpBootstrap/tools/configureDefaults.test.ts`

- [ ] **Step 1: Tool implementation**

```ts
// apps/api/src/modules/mcpBootstrap/tools/configureDefaults.ts
import { z } from 'zod';
import { requirePaymentMethod } from '../paymentGate';
import type { BootstrapTool } from '../types';
// These helpers likely already exist under services/configurationPolicy or similar;
// if not, extract from existing alert/risk/notification modules.
import {
  ensureDefaultDeviceGroup,
  applyStandardAlertPolicy,
  setRiskProfile,
  addNotificationChannel,
} from '../../../services/configurationPolicy';

const inputSchema = z.object({
  framework: z.enum(['standard', 'cis']).optional().default('standard'),
  risk_level: z.enum(['low', 'standard', 'strict']).optional().default('standard'),
});

const handler = async (input: z.infer<typeof inputSchema>, ctx: any) => {
  const partnerId = ctx.apiKey.partnerId;
  const orgId = ctx.apiKey.defaultOrgId;
  await ensureDefaultDeviceGroup(orgId);
  await applyStandardAlertPolicy(orgId, input.framework);
  await setRiskProfile(partnerId, input.risk_level);
  await addNotificationChannel(partnerId, { kind: 'email', target: ctx.apiKey.partnerAdminEmail });
  return {
    applied: {
      device_group: true,
      alert_policy: true,
      risk_profile: input.risk_level,
      notification: true,
    },
  };
};

export const configureDefaultsTool: BootstrapTool = {
  definition: {
    name: 'configure_defaults',
    description: 'Apply an opinionated baseline to this tenant in a single call: default device group, standard alert policy (CPU>90%/5m, disk<10%, offline>15m), risk engine profile, admin-email notification channel. Idempotent. Call once after verify_tenant returns active.',
    inputSchema,
  },
  handler: requirePaymentMethod(handler),
};
```

> **Implementation note:** `ensureDefaultDeviceGroup`, `applyStandardAlertPolicy`, `setRiskProfile`, `addNotificationChannel` helpers may need extracting from existing handlers. Each is a small wrapper around existing CRUD — use the existing tools under `services/aiToolsAnalytics.ts` / `configurationPolicy` as starting points.

- [ ] **Step 2: Test + commit**

Commit message: `feat(mcp-bootstrap): configure_defaults opinionated-baseline wrapper`

### Task 6.2: Extend `get_fleet_status` with invite funnel counts

**Files:**
- Modify: existing fleet-status tool (likely in `apps/api/src/services/aiToolsDevice.ts` or sibling; find via grep for `get_fleet_status`)

- [ ] **Step 1: Augment response shape**

Add to the returned object:

```ts
{
  // existing fields …
  total_invited: number,
  invites_clicked: number,
  devices_enrolled: number,
  devices_online: number,
  recent_enrollments: Array<{ device_id: string; hostname: string; os: string; invited_email: string; enrolled_at: string }>,
}
```

Compute via a single JOIN query on `deployment_invites` + `devices`.

- [ ] **Step 2: Test + commit**

### Task 6.3: Audit event type smoke test

**Files:**
- Modify: the existing audit-read tool test (or add small coverage)

- [ ] **Step 1: Assert new action strings surface**

Insert a fixture row with `action='invite.sent'` and call `get_recent_activity` → assert it's returned. Repeats for `partner.mcp_provisioned`, `partner.activation_completed`, `partner.payment_method_attached`, `invite.clicked`, `invite.enrolled`.

- [ ] **Step 2: Commit**

---

## Phase 7 — `delete_tenant` (flag-independent)

### Task 7.1: Tier-3+ authed tool with typed confirmation

**Files:**
- Create: `apps/api/src/routes/deleteTenant.ts`
- Create: `apps/api/src/routes/deleteTenant.test.ts`
- Modify: `apps/api/src/services/aiTools.ts` to register

- [ ] **Step 1: Failing test**

```ts
describe('delete_tenant', () => {
  it('rejects cross-tenant deletion', async () => { /* tenant_id !== apiKey.partnerId → CROSS_TENANT_FORBIDDEN */ });
  it('rejects wrong confirmation phrase', async () => { /* e.g. "delete Acme permanently" when org_name is "ACME Corp" → BAD_CONFIRMATION */ });
  it('soft-deletes when phrase matches exactly (lowercase)', async () => { /* sets status='soft_deleted', deletedAt */ });
});
```

- [ ] **Step 2: Implementation**

```ts
// apps/api/src/routes/deleteTenant.ts
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partners } from '../db/schema';
import { writeAuditEvent } from '../services/auditEvents';

const inputSchema = z.object({
  tenant_id: z.string().uuid(),
  confirmation_phrase: z.string(),
});

export const deleteTenantTool = {
  tier: 3,
  definition: {
    name: 'delete_tenant',
    description: 'Soft-delete this tenant (30-day restore window). confirmation_phrase must exactly equal `delete <org_name> permanently` (lowercase). Can only delete the tenant this API key belongs to.',
    inputSchema,
  },
  handler: async (input: z.infer<typeof inputSchema>, ctx: any) => {
    if (input.tenant_id !== ctx.apiKey.partnerId) {
      throw Object.assign(new Error('Cross-tenant deletion forbidden.'), { code: 'CROSS_TENANT_FORBIDDEN' });
    }
    const [p] = await db.select({ name: partners.name }).from(partners).where(eq(partners.id, input.tenant_id)).limit(1);
    if (!p) throw new Error('Unknown tenant.');
    const expected = `delete ${p.name.toLowerCase()} permanently`;
    if (input.confirmation_phrase.trim().toLowerCase() !== expected) {
      throw Object.assign(new Error(`confirmation_phrase must equal exactly: "${expected}"`), { code: 'BAD_CONFIRMATION' });
    }
    await db.update(partners)
      .set({ status: 'soft_deleted', deletedAt: new Date() } as any)
      .where(eq(partners.id, input.tenant_id));
    writeAuditEvent(ctx, {
      actorType: 'api_key', actorId: ctx.apiKey.id,
      action: 'partner.soft_deleted', resourceType: 'partner',
      resourceId: input.tenant_id, result: 'success',
    });
    return { soft_deleted: true, restore_window_days: 30 };
  },
};
```

> **Implementation note:** `partners` may need a `deleted_at` column if not already present. Add it in a small follow-on migration before this task lands.

- [ ] **Step 3: Register in `aiTools.ts`**

```ts
import { deleteTenantTool } from '../routes/deleteTenant';
aiTools.set(deleteTenantTool.definition.name, deleteTenantTool);
```

- [ ] **Step 4: Test + commit**

Commit message: `feat(mcp): delete_tenant tier-3 tool with typed confirmation`

---

## Phase 8 — Web UI label, observability, docs

### Task 8.1: API key list label for MCP-minted keys

**Files:**
- Modify: the component rendering `/partner/settings/api-keys`

- [ ] **Step 1: Add badge when `key.source === 'mcp_provisioning'`**

```tsx
{key.source === 'mcp_provisioning' && <span className="badge">MCP Provisioning</span>}
```

- [ ] **Step 2: Add `source` field to the API key list endpoint response** (if not already present).

- [ ] **Step 3: Test + commit**

### Task 8.2: OpenTelemetry metric

**Files:**
- Modify: `apps/api/src/modules/mcpBootstrap/index.ts`

- [ ] **Step 1: Add a counter `mcp_bootstrap_activations_total{status=<pending_email|pending_payment|active|expired>}` that increments in `verify_tenant` and activation-route handlers.**

Use the existing OpenTelemetry setup (likely `@opentelemetry/api`).

- [ ] **Step 2: Commit**

Commit message: `feat(mcp-bootstrap): activation funnel metric`

---

## Phase 9 — Integration tests + E2E + manual demo rehearsal

### Task 9.1: Full-flow integration test

**Files:**
- Create: `apps/api/src/__tests__/integration/mcpBootstrap.integration.test.ts`

- [ ] **Step 1: End-to-end integration test**

```ts
// apps/api/src/__tests__/integration/mcpBootstrap.integration.test.ts
describe('MCP bootstrap end-to-end', () => {
  it('create → pending_email → email-click → pending_payment → Stripe webhook → active → authed call', async () => {
    // 1. unauth tools/call create_tenant
    // 2. verify_tenant → pending_email
    // 3. GET /activate/:token (simulate email click)
    // 4. verify_tenant → pending_payment, capture api_key
    // 5. Signed Stripe webhook POST /activate/complete/webhook
    // 6. verify_tenant → active
    // 7. send_deployment_invites with api_key → expect invites_sent: 1
  });
});
```

Runs against real Postgres; stubs Stripe via signed-event fixtures; skips email actually being sent (mock the email service module).

- [ ] **Step 2: Commit**

### Task 9.2: Test-mode hooks

**Files:**
- Modify: `apps/api/src/modules/mcpBootstrap/activationRoutes.ts`

- [ ] **Step 1: Add two test-only routes guarded by `MCP_BOOTSTRAP_TEST_MODE=true`**

```ts
if (process.env.MCP_BOOTSTRAP_TEST_MODE === 'true') {
  app.post('/test/activate/:token', async (c) => { /* same effect as GET /activate/:token */ });
  app.post('/test/complete-payment/:partner_id', async (c) => { /* mark paid + upgrade scope, bypass Stripe */ });
}
```

Both return 404 when the env is unset.

- [ ] **Step 2: Commit**

Commit message: `test(mcp-bootstrap): MCP_BOOTSTRAP_TEST_MODE hooks for E2E`

### Task 9.3: YAML E2E test

**Files:**
- Create: `e2e-tests/tests/mcp_bootstrap.yaml`

- [ ] **Step 1: Write the test (follow `tests/agent_install.yaml` patterns)**

Stages:
1. `api` POST unauth'd tools/call `create_tenant` — extract `tenant_id`.
2. `api` POST unauth'd tools/call `verify_tenant` → expect `pending_email`.
3. `api` POST `/test/activate/<token>` (token pulled via a DB-read fixture).
4. `api` POST unauth'd tools/call `verify_tenant` → expect `pending_payment`, extract `api_key`.
5. `api` POST `/test/complete-payment/<tenant_id>`.
6. `api` POST authed tools/call `send_deployment_invites` with `{ emails: ["test+{{runId}}@acme-test.invalid"] }`.
7. `api` POST authed tools/call `get_fleet_status` → expect `total_invited >= 1`.

- [ ] **Step 2: Run locally**

Run: `cd e2e-tests && MCP_BOOTSTRAP_ENABLED=true MCP_BOOTSTRAP_TEST_MODE=true npx tsx run.ts --mode live --only mcp_bootstrap`

- [ ] **Step 3: Commit**

Commit message: `test(e2e): mcp_bootstrap flow`

### Task 9.4: Manual demo rehearsal runbook

**Files:**
- Create: `docs/superpowers/runbooks/2026-04-20-mcp-bootstrap-demo-rehearsal.md`

- [ ] **Step 1: Document the rehearsal**

```markdown
# MCP Bootstrap Demo Rehearsal

## Prereqs
- Real admin email inbox access.
- Real Stripe test card: 4242 4242 4242 4242, any future date, any CVC, any ZIP.
- One Mac + one Windows device available for install.
- Breeze Cloud staging with MCP_BOOTSTRAP_ENABLED=true, BREEZE_BILLING_URL set,
  PUBLIC_ACTIVATION_BASE_URL set.
- breeze-billing staging pointing at Stripe test mode.

## Steps
1. Connect staging MCP endpoint (`https://staging-us.2breeze.app/mcp`) to Claude.ai as a connector.
2. Prompt: "Set up Breeze RMM for Acme Corp. Admin email is <real@yourcompany.com>. Send install invites to <email1>, <email2>."
3. Observe: agent calls create_tenant → verify_tenant polling.
4. Open email, click activation link. Complete Stripe SetupIntent with the test card.
5. Observe: agent's next verify_tenant poll returns active, agent proceeds to configure_defaults and send_deployment_invites.
6. Open invite emails on each device, install the agent.
7. Observe: agent's get_fleet_status shows both devices; get_fleet_health returns findings.

## Timing target
< 5 minutes from first tool call to "X devices online, here's what I found."

## Rollback
If a step fails catastrophically mid-demo, call `delete_tenant` with the typed confirmation and restart.
```

- [ ] **Step 2: Commit**

Commit message: `docs: MCP bootstrap demo rehearsal runbook`

---

## Self-review (performed against spec)

- **Spec coverage:** every spec section maps to tasks — architecture (Phases 1–2), tool surface (Phases 2, 5, 6, 7), data model (Tasks 1.1–1.3), activation flow (Phases 2–4), email-invite pipeline (Phase 5), abuse controls (Task 2.2 rate limits, Task 1.5 business-email, Tasks 4.1–4.2 payment gate), audit logging (woven throughout), tenant isolation (Tasks 1.1 + 1.3 RLS), testing (Phase 9), v1 scope (Phases 1–9), feature-flag packaging (Task 1.6 + 2.5 + 3.2 + 5.2), web UI label (Task 8.1), observability (Task 8.2).
- **Placeholder scan:** a handful of helpers are named but not fully implemented inline (`mintChildEnrollmentKey`, `allocateShortCode`, `redeemShortCode` in `enrollmentKeys.ts`; `ensureDefaultDeviceGroup`, `applyStandardAlertPolicy`, `setRiskProfile`, `addNotificationChannel` in a configuration-policy module). Each is called out as an "extract from existing internal code, no behavior change" step. Implementers will find the original code by grep and promote it to a module export.
- **Type consistency:** `partnerId` used throughout at boundaries. `api_keys.orgId` is reused as the partner-scoped key column, with an implementation note in Task 2.3 to verify column semantics and add a `partner_id` column if needed.
- **Scope:** this is a single focused v1 plan. Server-auto first-run AI health, invite resend/cancel, paid-plan upgrade, SMS/Slack/Teams channels, and teardown restore are deferred to v2 per the spec.
