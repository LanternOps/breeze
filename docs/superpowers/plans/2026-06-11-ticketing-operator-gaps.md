# Ticketing Operator Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three operator-facing ticketing gaps: a write API + org-settings Portal tab for `portal_branding`, a Create-ticket button + linked-tickets view on alert detail, and up/down category reordering.

**Architecture:** Three independent features in one PR, per the approved spec (`docs/superpowers/specs/2026-06-11-ticketing-operator-gaps-design.md`). API work is Hono routes with Drizzle, tested with the established Drizzle-mock Vitest pattern; web work is React islands using the `runAction` mutation wrapper. No new tables, migrations, or dependencies.

**Tech Stack:** Hono + Drizzle (apps/api), Zod validators (packages/shared), React + Vitest/jsdom + Testing Library (apps/web).

---

## Environment notes (read first)

- Work in this worktree: `/Users/toddhebebrand/breeze/.claude/worktrees/ticketing-review-followups`, branch `worktree-ticketing-review-followups`. Earlier commits on this branch are already merged to main; a new PR from this branch will show only the new commits.
- **Node:** prefix every `pnpm`/`npx vitest`/`npx tsc` command with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict). If `node_modules` is missing, run `pnpm install` first.
- **Tests:** run only the affected test files, single-fork (`--pool=forks --poolOptions.forks.singleFork=true` for apps/api). The full API suite has known parallel flakiness — trust CI for the full run.
- **Type-check:** `npx tsc --noEmit` in apps/api has pre-existing errors in `agents.test.ts` and `apiKeyAuth.test.ts` — those two are not regressions.
- All web mutation handlers MUST go through `runAction` (`apps/web/src/lib/runAction.ts`). Catch pattern: `if (!(err instanceof ActionError)) throw err;` after the await.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `packages/shared/src/validators/portal.ts` | create | `updatePortalSettingsSchema` (admin-writable portal_branding subset) |
| `packages/shared/src/validators/portal.test.ts` | create | Validator tests |
| `packages/shared/src/validators/index.ts` | modify | Barrel export |
| `apps/api/src/routes/orgPortalSettings.ts` | create | GET/PATCH `/organizations/:id/portal-settings` handlers, registered onto `orgRoutes` |
| `apps/api/src/routes/orgPortalSettings.test.ts` | create | Route tests |
| `apps/api/src/routes/orgs.ts` | modify | Import + call `registerOrgPortalSettingsRoutes(orgRoutes)` |
| `apps/api/src/routes/alerts/alerts.ts` | modify | New `GET /:id/tickets` |
| `apps/api/src/routes/alerts/alertTickets.test.ts` | create | Tests for the new alerts endpoint |
| `apps/api/src/routes/ticketCategories.ts` | modify | New `PUT /reorder` |
| `apps/api/src/routes/ticketCategories.test.ts` | modify | Reorder tests + thenable `where()` mock |
| `apps/web/src/components/settings/OrgPortalSettingsEditor.tsx` | create | Portal tab editor |
| `apps/web/src/components/settings/OrgPortalSettingsEditor.test.tsx` | create | Editor tests |
| `apps/web/src/components/settings/OrgSettingsPage.tsx` | modify | Add `portal` tab |
| `apps/web/src/components/settings/TicketCategoriesPage.tsx` | modify | `moveWithinSiblings` helper + ▲/▼ buttons |
| `apps/web/src/components/settings/TicketCategoriesPage.test.tsx` | modify | Reorder tests |
| `apps/web/src/components/alerts/CreateTicketFromAlertDialog.tsx` | create | Create-ticket dialog |
| `apps/web/src/components/alerts/CreateTicketFromAlertDialog.test.tsx` | create | Dialog tests |
| `apps/web/src/components/alerts/AlertDetailPage.tsx` | modify | Button + linked-tickets section |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | modify | Add new components to `TARGET_GLOBS` |
| `docs/superpowers/specs/2026-06-11-ticketing-operator-gaps-design.md` | modify | One-line deviation note (web permission gating) |

---

### Task 1: Shared validator `updatePortalSettingsSchema`

**Files:**
- Create: `packages/shared/src/validators/portal.ts`
- Create: `packages/shared/src/validators/portal.test.ts`
- Modify: `packages/shared/src/validators/index.ts` (add one export line)

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/validators/portal.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { updatePortalSettingsSchema } from './portal';

describe('updatePortalSettingsSchema', () => {
  it('accepts a full valid payload', () => {
    const result = updatePortalSettingsSchema.safeParse({
      enableTickets: false,
      enableAssetCheckout: true,
      enableSelfService: true,
      enablePasswordReset: false,
      supportEmail: 'help@msp.example',
      supportPhone: '+1 555 0100',
      welcomeMessage: 'Welcome to support',
      footerText: 'MSP Inc.'
    });
    expect(result.success).toBe(true);
  });

  it('accepts a partial payload (single toggle)', () => {
    expect(updatePortalSettingsSchema.safeParse({ enableTickets: false }).success).toBe(true);
  });

  it('accepts an empty object (route layer rejects no-op separately)', () => {
    expect(updatePortalSettingsSchema.safeParse({}).success).toBe(true);
  });

  it('accepts null for the nullable string fields', () => {
    const result = updatePortalSettingsSchema.safeParse({
      supportEmail: null, supportPhone: null, welcomeMessage: null, footerText: null
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown keys (visual branding fields are not writable here)', () => {
    expect(updatePortalSettingsSchema.safeParse({ customDomain: 'evil.example' }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ logoUrl: 'https://x/y.png' }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ domainVerified: true }).success).toBe(false);
  });

  it('rejects an invalid support email', () => {
    expect(updatePortalSettingsSchema.safeParse({ supportEmail: 'not-an-email' }).success).toBe(false);
  });

  it('rejects null booleans', () => {
    expect(updatePortalSettingsSchema.safeParse({ enableTickets: null }).success).toBe(false);
  });

  it('rejects over-length strings', () => {
    expect(updatePortalSettingsSchema.safeParse({ supportPhone: 'x'.repeat(51) }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ supportEmail: `${'a'.repeat(250)}@b.example` }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ welcomeMessage: 'x'.repeat(2001) }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ footerText: 'x'.repeat(2001) }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/validators/portal.test.ts`
Expected: FAIL — cannot resolve `./portal`.

- [ ] **Step 3: Write the validator**

Create `packages/shared/src/validators/portal.ts`:

```ts
import { z } from 'zod';

// Admin-writable subset of portal_branding (feature toggles + support contact).
// Visual branding (logo, colors, customCss) and customDomain/domainVerified are
// deliberately NOT writable here — they ship with the domain-verification
// project. `.strict()` is the enforcement: unknown keys are rejected.
export const updatePortalSettingsSchema = z.object({
  enableTickets: z.boolean().optional(),
  enableAssetCheckout: z.boolean().optional(),
  enableSelfService: z.boolean().optional(),
  enablePasswordReset: z.boolean().optional(),
  supportEmail: z.string().email().max(255).nullable().optional(),
  supportPhone: z.string().max(50).nullable().optional(),
  welcomeMessage: z.string().max(2000).nullable().optional(),
  footerText: z.string().max(2000).nullable().optional()
}).strict();

export type UpdatePortalSettingsInput = z.infer<typeof updatePortalSettingsSchema>;
```

In `packages/shared/src/validators/index.ts`, next to the existing line `export * from './tickets';` (line ~595), add:

```ts
export * from './portal';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/validators/portal.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/portal.ts packages/shared/src/validators/portal.test.ts packages/shared/src/validators/index.ts
git commit -m "feat(shared): updatePortalSettingsSchema for portal settings write API"
```

---

### Task 2: API — org portal settings GET/PATCH

**Files:**
- Create: `apps/api/src/routes/orgPortalSettings.ts`
- Create: `apps/api/src/routes/orgPortalSettings.test.ts`
- Modify: `apps/api/src/routes/orgs.ts` (import + one registration call)

Routes are registered onto the existing `orgRoutes` via a register function (not a mounted sub-router) so they inherit `orgRoutes.use('*', authMiddleware)` (orgs.ts:199) and keep the 1292-line orgs.ts from growing.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/orgPortalSettings.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, dbSelectResult, dbUpsertReturning, auditSpy } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null,
      orgCondition: () => undefined,
      canAccessOrg: (_id: string) => true as boolean
    }
  },
  dbSelectResult: vi.fn(),
  dbUpsertReturning: vi.fn(),
  auditSpy: vi.fn()
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: () => async (c: any, next: any) => {
    if (!c.get('auth')) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next()
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => dbSelectResult())
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(() => ({
          returning: vi.fn(() => dbUpsertReturning())
        }))
      }))
    }))
  }
}));

vi.mock('../db/schema', () => ({
  portalBranding: {
    orgId: 'orgId',
    enableTickets: 'enableTickets',
    enableAssetCheckout: 'enableAssetCheckout',
    enableSelfService: 'enableSelfService',
    enablePasswordReset: 'enablePasswordReset',
    supportEmail: 'supportEmail',
    supportPhone: 'supportPhone',
    welcomeMessage: 'welcomeMessage',
    footerText: 'footerText',
    updatedAt: 'updatedAt'
  },
  organizations: { id: 'id', deletedAt: 'deletedAt' }
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => auditSpy(...args)
}));

import { authMiddleware } from '../middleware/auth';
import { registerOrgPortalSettingsRoutes } from './orgPortalSettings';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';

const FULL_ROW = {
  id: 'row-1',
  orgId: ORG_ID,
  enableTickets: false,
  enableAssetCheckout: true,
  enableSelfService: true,
  enablePasswordReset: true,
  supportEmail: 'help@msp.example',
  supportPhone: null,
  welcomeMessage: 'Welcome',
  footerText: null,
  // Read-only columns that must never leak into the response payload:
  customDomain: 'portal.customer.example',
  customCss: 'body{}',
  logoUrl: 'https://x/logo.png'
};

const DEFAULT_AUTH = {
  scope: 'partner' as string,
  user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
  partnerId: 'p-1' as string | null,
  orgId: null as string | null,
  accessibleOrgIds: null as string[] | null,
  orgCondition: () => undefined,
  canAccessOrg: (_id: string) => true as boolean
};

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware as any);
  registerOrgPortalSettingsRoutes(app);
  return app;
}

function resetAuth(overrides: Partial<typeof DEFAULT_AUTH> = {}) {
  authRef.current = { ...DEFAULT_AUTH, ...overrides } as typeof authRef.current;
}

describe('GET /organizations/:id/portal-settings', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('returns the managed subset when a row exists (never visual branding columns)', async () => {
    dbSelectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org existence check
      .mockResolvedValueOnce([FULL_ROW]);      // portal_branding row
    const res = await makeApp().request(`/organizations/${ORG_ID}/portal-settings`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      orgId: ORG_ID,
      enableTickets: false,
      enableAssetCheckout: true,
      enableSelfService: true,
      enablePasswordReset: true,
      supportEmail: 'help@msp.example',
      supportPhone: null,
      welcomeMessage: 'Welcome',
      footerText: null
    });
    expect(JSON.stringify(body)).not.toContain('customDomain');
    expect(JSON.stringify(body)).not.toContain('customCss');
  });

  it('returns schema defaults when no row exists', async () => {
    dbSelectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([]);
    const res = await makeApp().request(`/organizations/${ORG_ID}/portal-settings`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      orgId: ORG_ID,
      enableTickets: true,
      enableAssetCheckout: true,
      enableSelfService: true,
      enablePasswordReset: true,
      supportEmail: null,
      supportPhone: null,
      welcomeMessage: null,
      footerText: null
    });
  });

  it('404 when the org does not exist (or is soft-deleted)', async () => {
    dbSelectResult.mockResolvedValueOnce([]);
    const res = await makeApp().request(`/organizations/${ORG_ID}/portal-settings`);
    expect(res.status).toBe(404);
  });

  it('404 when partner scope cannot access the org', async () => {
    resetAuth({ canAccessOrg: () => false });
    const res = await makeApp().request(`/organizations/${ORG_ID}/portal-settings`);
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty('error', 'Organization not found');
  });

  it('401 when unauthenticated', async () => {
    authRef.current = null as unknown as typeof authRef.current;
    const res = await makeApp().request(`/organizations/${ORG_ID}/portal-settings`);
    expect(res.status).toBe(401);
  });
});

describe('PATCH /organizations/:id/portal-settings', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  const patch = (body: unknown) =>
    makeApp().request(`/organizations/${ORG_ID}/portal-settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

  it('upserts and returns the managed subset', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    dbUpsertReturning.mockResolvedValue([{ ...FULL_ROW, enableTickets: true }]);
    const res = await patch({ enableTickets: true, supportEmail: 'help@msp.example' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.enableTickets).toBe(true);
    expect(body.data.orgId).toBe(ORG_ID);

    const { db } = await import('../db');
    const valuesArg = vi.mocked(db.insert).mock.results[0]?.value.values.mock.calls[0]?.[0];
    expect(valuesArg.orgId).toBe(ORG_ID);
    expect(valuesArg.enableTickets).toBe(true);
    const conflictArg = vi.mocked(db.insert).mock.results[0]?.value.values.mock.results[0]?.value
      .onConflictDoUpdate.mock.calls[0]?.[0];
    expect(conflictArg.set.enableTickets).toBe(true);
    expect(conflictArg.set.updatedAt).toBeInstanceOf(Date);
  });

  it('writes an audit event', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    dbUpsertReturning.mockResolvedValue([FULL_ROW]);
    const res = await patch({ enableTickets: false });
    expect(res.status).toBe(200);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const event = auditSpy.mock.calls[0][1];
    expect(event.action).toBe('organization.portal_settings.update');
    expect(event.orgId).toBe(ORG_ID);
    expect(event.details.changedFields).toEqual(['enableTickets']);
  });

  it('400 on an empty body (no-op)', async () => {
    const res = await patch({});
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('error', 'No updates provided');
  });

  it('400 on unknown keys (visual branding not writable)', async () => {
    expect((await patch({ customDomain: 'evil.example' })).status).toBe(400);
  });

  it('400 on invalid email', async () => {
    expect((await patch({ supportEmail: 'nope' })).status).toBe(400);
  });

  it('404 when partner scope cannot access the org', async () => {
    resetAuth({ canAccessOrg: () => false });
    const res = await patch({ enableTickets: false });
    expect(res.status).toBe(404);
  });

  it('404 when the org does not exist', async () => {
    dbSelectResult.mockResolvedValueOnce([]);
    const res = await patch({ enableTickets: false });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/orgPortalSettings.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — cannot resolve `./orgPortalSettings`.

- [ ] **Step 3: Write the route file**

Create `apps/api/src/routes/orgPortalSettings.ts`:

```ts
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { organizations, portalBranding } from '../db/schema';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { updatePortalSettingsSchema } from '@breeze/shared';

// Admin read/write for the org's customer-portal settings (portal_branding).
// Registered onto orgRoutes (not a mounted sub-router) so it inherits
// orgRoutes' authMiddleware. The public portal lookup routes in
// routes/portal/branding.ts stay read-only/pre-auth; this is the only write
// surface. Visual branding + customDomain are excluded by the strict schema —
// they ship with the domain-verification project.

const PORTAL_SETTINGS_DEFAULTS = {
  enableTickets: true,
  enableAssetCheckout: true,
  enableSelfService: true,
  enablePasswordReset: true,
  supportEmail: null,
  supportPhone: null,
  welcomeMessage: null,
  footerText: null
} as const;

type PortalSettingsRow = {
  enableTickets: boolean;
  enableAssetCheckout: boolean;
  enableSelfService: boolean;
  enablePasswordReset: boolean;
  supportEmail: string | null;
  supportPhone: string | null;
  welcomeMessage: string | null;
  footerText: string | null;
};

function toResponse(orgId: string, row?: PortalSettingsRow) {
  if (!row) return { orgId, ...PORTAL_SETTINGS_DEFAULTS };
  return {
    orgId,
    enableTickets: row.enableTickets,
    enableAssetCheckout: row.enableAssetCheckout,
    enableSelfService: row.enableSelfService,
    enablePasswordReset: row.enablePasswordReset,
    supportEmail: row.supportEmail,
    supportPhone: row.supportPhone,
    welcomeMessage: row.welcomeMessage,
    footerText: row.footerText
  };
}

async function resolveAccessibleOrg(c: any): Promise<{ id: string } | Response> {
  const auth = c.get('auth') as AuthContext;
  const id = c.req.param('id')!;
  if (auth.scope === 'partner' && !auth.canAccessOrg(id)) {
    return c.json({ error: 'Organization not found' }, 404);
  }
  const orgRows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, id), isNull(organizations.deletedAt)))
    .limit(1);
  if (!orgRows[0]) {
    return c.json({ error: 'Organization not found' }, 404);
  }
  return { id };
}

export function registerOrgPortalSettingsRoutes(orgRoutes: Hono) {
  const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
  const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

  orgRoutes.get(
    '/organizations/:id/portal-settings',
    requireScope('partner', 'system'),
    requireOrgRead,
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;

      const rows = await db
        .select()
        .from(portalBranding)
        .where(eq(portalBranding.orgId, org.id))
        .limit(1);
      // No auto-insert on read: defaults are reported until the first PATCH.
      return c.json({ data: toResponse(org.id, rows[0]) });
    }
  );

  orgRoutes.patch(
    '/organizations/:id/portal-settings',
    requireScope('partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    zValidator('json', updatePortalSettingsSchema),
    async (c) => {
      const body = c.req.valid('json');
      if (Object.keys(body).length === 0) {
        return c.json({ error: 'No updates provided' }, 400);
      }
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;

      // portal_branding has UNIQUE(org_id) — upsert keeps first-write and
      // subsequent edits on one code path.
      const [row] = await db
        .insert(portalBranding)
        .values({ orgId: org.id, ...body })
        .onConflictDoUpdate({
          target: portalBranding.orgId,
          set: { ...body, updatedAt: new Date() }
        })
        .returning();

      writeRouteAudit(c, {
        orgId: org.id,
        action: 'organization.portal_settings.update',
        resourceType: 'organization',
        resourceId: org.id,
        details: { changedFields: Object.keys(body) }
      });

      return c.json({ data: toResponse(org.id, row) });
    }
  );
}
```

- [ ] **Step 4: Register in orgs.ts**

In `apps/api/src/routes/orgs.ts`:

Add to the import block at the top (after line 26, `import { clearPartnerAllowlistCache, ... }`):

```ts
import { registerOrgPortalSettingsRoutes } from './orgPortalSettings';
```

After line 1028 (`orgRoutes.put('/organizations/:id', ...updateOrgHandler);`) add:

```ts
// Customer-portal settings (portal_branding) — see routes/orgPortalSettings.ts
registerOrgPortalSettingsRoutes(orgRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/orgPortalSettings.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS (12 tests).

Also run the org routes' existing tests to confirm registration broke nothing:
`npx vitest run src/routes/orgs.test.ts src/routes/organizations.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS. (If these fail on a *pristine* tree too, note it and move on — see Environment notes.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/orgPortalSettings.ts apps/api/src/routes/orgPortalSettings.test.ts apps/api/src/routes/orgs.ts
git commit -m "feat(api): org portal settings read/write endpoints (portal_branding upsert)"
```

---

### Task 3: API — `GET /alerts/:id/tickets` (linked tickets)

**Files:**
- Modify: `apps/api/src/routes/alerts/alerts.ts` (imports + one route at end of file)
- Create: `apps/api/src/routes/alerts/alertTickets.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/alerts/alertTickets.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, dbJoinResult, getAlertWithOrgCheckMock } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example' },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null,
      canAccessOrg: (_id: string) => true as boolean
    }
  },
  dbJoinResult: vi.fn(),
  getAlertWithOrgCheckMock: vi.fn()
}));

// requireScope injects auth here because alertsRoutes gets authMiddleware from
// routes/alerts/index.ts, which this test does not mount.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => {
    if (!authRef.current) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    c.set('auth', authRef.current);
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next()
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => dbJoinResult())
          }))
        })),
        // GET /:id and friends use other chains; tolerate them.
        where: vi.fn(() => ({
          orderBy: vi.fn(() => dbJoinResult()),
          limit: vi.fn(() => dbJoinResult())
        }))
      }))
    }))
  }
}));

vi.mock('../../db/schema', () => ({
  alertRules: {}, alertTemplates: {}, alerts: {}, notificationChannels: {},
  alertNotifications: {}, devices: {},
  tickets: {
    id: 'id', internalNumber: 'internalNumber', subject: 'subject',
    status: 'status', priority: 'priority'
  },
  ticketAlertLinks: {
    ticketId: 'ticketId', alertId: 'alertId', linkType: 'linkType', createdAt: 'createdAt'
  }
}));

vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  ensureOrgAccess: vi.fn(() => true),
  getAlertWithOrgCheck: (...args: unknown[]) => getAlertWithOrgCheckMock(...args)
}));

vi.mock('../../services/alertCooldown', () => ({
  setCooldown: vi.fn(),
  markConfigPolicyRuleCooldown: vi.fn()
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../../services/ticketService', () => ({
  createTicketFromAlert: vi.fn(),
  TicketServiceError: class TicketServiceError extends Error { status = 400; }
}));

import { alertsRoutes } from './alerts';

const ALERT_ID = '5d4c3b2a-1111-4222-8333-444455556666';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', alertsRoutes);
  return app;
}

describe('GET /alerts/:id/tickets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authRef.current = {
      scope: 'partner', user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example' },
      partnerId: 'p-1', orgId: null, accessibleOrgIds: null, canAccessOrg: () => true
    } as typeof authRef.current;
  });

  it('returns linked tickets for a visible alert', async () => {
    getAlertWithOrgCheckMock.mockResolvedValue({ id: ALERT_ID, orgId: 'org-1' });
    dbJoinResult.mockResolvedValue([
      {
        id: 't-1', internalNumber: 'T-2026-0042', subject: 'CPU pegged',
        status: 'open', priority: 'high', linkType: 'created_from',
        linkedAt: '2026-06-11T00:00:00.000Z'
      }
    ]);
    const res = await makeApp().request(`/alerts/${ALERT_ID}/tickets`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].internalNumber).toBe('T-2026-0042');
    expect(body.data[0].linkType).toBe('created_from');
  });

  it('returns an empty list when nothing is linked', async () => {
    getAlertWithOrgCheckMock.mockResolvedValue({ id: ALERT_ID, orgId: 'org-1' });
    dbJoinResult.mockResolvedValue([]);
    const res = await makeApp().request(`/alerts/${ALERT_ID}/tickets`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(0);
  });

  it('404 when the alert is not visible to the caller (cross-org)', async () => {
    getAlertWithOrgCheckMock.mockResolvedValue(null);
    const res = await makeApp().request(`/alerts/${ALERT_ID}/tickets`);
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty('error', 'Alert not found');
  });

  it('400 on a non-uuid alert id', async () => {
    const res = await makeApp().request('/alerts/not-a-uuid/tickets');
    expect(res.status).toBe(400);
  });

  it('401 when unauthenticated', async () => {
    authRef.current = null as unknown as typeof authRef.current;
    const res = await makeApp().request(`/alerts/${ALERT_ID}/tickets`);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/alerts/alertTickets.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — 404 on `/alerts/:id/tickets` (route doesn't exist; the param-validated tests fail accordingly).

- [ ] **Step 3: Add the route**

In `apps/api/src/routes/alerts/alerts.ts`:

Extend the schema import (lines 6–13) to include the two ticket tables:

```ts
import {
  alertRules,
  alertTemplates,
  alerts,
  notificationChannels,
  alertNotifications,
  devices,
  tickets,
  ticketAlertLinks,
} from '../../db/schema';
```

Append at the end of the file, after the `POST /:id/create-ticket` route (line ~696):

```ts
// GET /alerts/:id/tickets — tickets linked to this alert via ticket_alert_links
alertsRoutes.get(
  '/:id/tickets',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action),
  zValidator('param', alertIdParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const auth = c.get('auth');

    const alert = await getAlertWithOrgCheck(id, auth);
    if (!alert) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    const data = await db
      .select({
        id: tickets.id,
        internalNumber: tickets.internalNumber,
        subject: tickets.subject,
        status: tickets.status,
        priority: tickets.priority,
        linkType: ticketAlertLinks.linkType,
        linkedAt: ticketAlertLinks.createdAt
      })
      .from(ticketAlertLinks)
      .innerJoin(tickets, eq(ticketAlertLinks.ticketId, tickets.id))
      .where(eq(ticketAlertLinks.alertId, id))
      .orderBy(desc(ticketAlertLinks.createdAt));

    return c.json({ data });
  }
);
```

(`eq`, `desc`, `db`, `requireScope`, `requirePermission`, `zValidator`, `PERMISSIONS`, `getAlertWithOrgCheck`, and `alertIdParamSchema` are already imported/defined in this file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/alerts/alertTickets.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/alerts/alerts.ts apps/api/src/routes/alerts/alertTickets.test.ts
git commit -m "feat(api): GET /alerts/:id/tickets — linked tickets for an alert"
```

---

### Task 4: API — `PUT /ticket-categories/reorder`

**Files:**
- Modify: `apps/api/src/routes/ticketCategories.ts`
- Modify: `apps/api/src/routes/ticketCategories.test.ts`

Bulk endpoint, not per-row swaps: all pre-existing categories tie at `sortOrder = 0` (swapping ties is a no-op) and paired PATCHes aren't atomic. `withDbAccessContext` already wraps each request in a transaction (`apps/api/src/db/index.ts:107`), so the sequential UPDATEs commit atomically.

- [ ] **Step 1: Make the existing select-mock awaitable at `where()`**

The reorder handler awaits `select().from().where(...)` directly (no `.limit()`/`.orderBy()`). In `apps/api/src/routes/ticketCategories.test.ts`, replace the `select` mock inside `vi.mock('../db', ...)` (lines 55–63):

```ts
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => dbSelectResult()),
          limit: vi.fn(() => dbSelectResult()),
          // The reorder route awaits where() directly (no orderBy/limit) —
          // make the chain object thenable so `await db.select()...where(...)` works.
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(dbSelectResult()).then(resolve, reject)
        })),
        orderBy: vi.fn(() => dbSelectResult())
      }))
    })),
```

Run the existing file to confirm nothing regressed:
`cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/ticketCategories.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS (all existing tests).

- [ ] **Step 2: Write the failing tests**

Append to `apps/api/src/routes/ticketCategories.test.ts`:

```ts
describe('PUT /ticket-categories/reorder', () => {
  const ID_A = 'aaaaaaaa-1111-4222-8333-444455556666';
  const ID_B = 'bbbbbbbb-1111-4222-8333-444455556666';
  const ID_C = 'cccccccc-1111-4222-8333-444455556666';

  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  const reorder = (body: unknown) =>
    makeApp().request('/ticket-categories/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

  it('assigns sortOrder by array position', async () => {
    dbSelectResult.mockResolvedValueOnce([
      { id: ID_A, partnerId: 'p-1' },
      { id: ID_B, partnerId: 'p-1' },
      { id: ID_C, partnerId: 'p-1' }
    ]);
    const res = await reorder({ ids: [ID_B, ID_A, ID_C] });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('success', true);

    const { db } = await import('../db');
    const updates = vi.mocked(db.update).mock.results;
    expect(updates).toHaveLength(3);
    expect(updates[0]?.value.set.mock.calls[0]?.[0].sortOrder).toBe(0);
    expect(updates[1]?.value.set.mock.calls[0]?.[0].sortOrder).toBe(1);
    expect(updates[2]?.value.set.mock.calls[0]?.[0].sortOrder).toBe(2);
  });

  it('404 wholesale when any id belongs to another partner — no updates run', async () => {
    dbSelectResult.mockResolvedValueOnce([
      { id: ID_A, partnerId: 'p-1' },
      { id: ID_B, partnerId: 'p-OTHER' }
    ]);
    const res = await reorder({ ids: [ID_A, ID_B] });
    expect(res.status).toBe(404);
    const { db } = await import('../db');
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it('404 when an id does not exist (fewer rows than ids)', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: ID_A, partnerId: 'p-1' }]);
    const res = await reorder({ ids: [ID_A, ID_B] });
    expect(res.status).toBe(404);
  });

  it('400 on duplicate ids', async () => {
    expect((await reorder({ ids: [ID_A, ID_A] })).status).toBe(400);
  });

  it('400 on an empty array', async () => {
    expect((await reorder({ ids: [] })).status).toBe(400);
  });

  it('403 when partner scope has null partnerId', async () => {
    resetAuth({ scope: 'partner', partnerId: null });
    expect((await reorder({ ids: [ID_A] })).status).toBe(403);
  });

  it('system scope: accepts ids that all share one partner', async () => {
    resetAuth({ scope: 'system', partnerId: null });
    dbSelectResult.mockResolvedValueOnce([
      { id: ID_A, partnerId: 'p-2' },
      { id: ID_B, partnerId: 'p-2' }
    ]);
    expect((await reorder({ ids: [ID_A, ID_B] })).status).toBe(200);
  });

  it('system scope: rejects ids spanning two partners', async () => {
    resetAuth({ scope: 'system', partnerId: null });
    dbSelectResult.mockResolvedValueOnce([
      { id: ID_A, partnerId: 'p-1' },
      { id: ID_B, partnerId: 'p-2' }
    ]);
    expect((await reorder({ ids: [ID_A, ID_B] })).status).toBe(404);
  });
});
```

Run: same vitest command as Step 1. Expected: new tests FAIL (404 route-not-found), existing tests still PASS.

- [ ] **Step 3: Add the endpoint**

In `apps/api/src/routes/ticketCategories.ts`:

Change the drizzle import (line 4) to include `inArray`:

```ts
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
```

Insert between the `GET /` route (ends line 86) and the `POST /` route (line 88):

```ts
const reorderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200)
}).refine((v) => new Set(v.ids).size === v.ids.length, {
  message: 'ids must be unique',
  path: ['ids']
});

// PUT /ticket-categories/reorder — assign sortOrder by array position.
// Bulk (not per-row swaps): pre-existing rows all tie at sortOrder=0, so
// swapping tied values is a no-op, and paired PATCHes aren't atomic. The
// client sends one sibling group's ids in their new order; the endpoint is
// hierarchy-agnostic. withDbAccessContext wraps the request in a transaction,
// so the sequential updates commit atomically.
ticketCategoriesRoutes.put(
  '/reorder',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('json', reorderSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (auth.scope === 'partner' && !auth.partnerId) {
      return c.json({ error: 'Partner context required' }, 403);
    }
    const { ids } = c.req.valid('json');

    // Every id must exist and belong to ONE partner — the caller's for partner
    // scope. Reject wholesale otherwise: no partial reorders.
    const rows = await db
      .select({ id: ticketCategories.id, partnerId: ticketCategories.partnerId })
      .from(ticketCategories)
      .where(inArray(ticketCategories.id, ids));
    const partnerIds = new Set(rows.map((r) => r.partnerId));
    const expectedPartner = auth.scope === 'partner' ? auth.partnerId : rows[0]?.partnerId;
    if (rows.length !== ids.length || partnerIds.size !== 1 || !expectedPartner || !partnerIds.has(expectedPartner)) {
      return c.json({ error: 'One or more categories not found' }, 404);
    }

    for (const [index, id] of ids.entries()) {
      await db.update(ticketCategories)
        .set({ sortOrder: index, updatedAt: new Date() })
        .where(eq(ticketCategories.id, id));
    }
    return c.json({ success: true });
  }
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/ticketCategories.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS (all existing + 8 new).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/ticketCategories.ts apps/api/src/routes/ticketCategories.test.ts
git commit -m "feat(api): PUT /ticket-categories/reorder — bulk sortOrder assignment"
```

---

### Task 5: Web — Portal tab on org settings

**Files:**
- Create: `apps/web/src/components/settings/OrgPortalSettingsEditor.tsx`
- Create: `apps/web/src/components/settings/OrgPortalSettingsEditor.test.tsx`
- Modify: `apps/web/src/components/settings/OrgSettingsPage.tsx`
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (TARGET_GLOBS)

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/settings/OrgPortalSettingsEditor.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OrgPortalSettingsEditor from './OrgPortalSettingsEditor';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';

const SETTINGS = {
  orgId: ORG_ID,
  enableTickets: true,
  enableAssetCheckout: true,
  enableSelfService: false,
  enablePasswordReset: true,
  supportEmail: 'help@msp.example',
  supportPhone: null,
  welcomeMessage: 'Welcome!',
  footerText: null
};

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

function mockApi(settings: unknown = SETTINGS) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/orgs/organizations/${ORG_ID}/portal-settings` && !init?.method) {
      return makeJsonResponse({ data: settings });
    }
    if (url === `/orgs/organizations/${ORG_ID}/portal-settings` && init?.method === 'PATCH') {
      return makeJsonResponse({ data: settings });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
}

describe('OrgPortalSettingsEditor', () => {
  const onDirty = vi.fn();
  const onSave = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads and renders the fetched settings', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-portal-settings')).toBeInTheDocument());
    expect((screen.getByTestId('org-portal-toggle-enableTickets') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('org-portal-toggle-enableSelfService') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('org-portal-support-email') as HTMLInputElement).value).toBe('help@msp.example');
    expect((screen.getByTestId('org-portal-support-phone') as HTMLInputElement).value).toBe('');
  });

  it('marks dirty when a toggle changes', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-portal-toggle-enableTickets')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('org-portal-toggle-enableTickets'));
    expect(onDirty).toHaveBeenCalled();
  });

  it('saves via PATCH with empty strings normalized to null, then calls onSave', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-portal-save')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('org-portal-toggle-enableTickets'));
    fireEvent.change(screen.getByTestId('org-portal-support-email'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('org-portal-save'));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    const body = JSON.parse(String(patchCall![1]!.body));
    expect(body.enableTickets).toBe(false);
    expect(body.supportEmail).toBeNull();
    expect(body.welcomeMessage).toBe('Welcome!');
  });

  it('shows an error state with retry when the load fails', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-portal-load-error')).toBeInTheDocument());
  });

  it('does not call onSave when the PATCH fails (runAction toasts the error)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'PATCH') return makeJsonResponse({ error: 'nope' }, false, 500);
      return makeJsonResponse({ data: SETTINGS });
    });
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-portal-save')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('org-portal-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(onSave).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/settings/OrgPortalSettingsEditor.test.tsx`
Expected: FAIL — cannot resolve `./OrgPortalSettingsEditor`.

- [ ] **Step 3: Write the component**

Create `apps/web/src/components/settings/OrgPortalSettingsEditor.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '@/lib/runAction';

type PortalSettings = {
  enableTickets: boolean;
  enableAssetCheckout: boolean;
  enableSelfService: boolean;
  enablePasswordReset: boolean;
  supportEmail: string | null;
  supportPhone: string | null;
  welcomeMessage: string | null;
  footerText: string | null;
};

type ToggleKey = 'enableTickets' | 'enableAssetCheckout' | 'enableSelfService' | 'enablePasswordReset';

const TOGGLES: Array<{ key: ToggleKey; label: string; description: string }> = [
  { key: 'enableTickets', label: 'Ticket submission', description: 'Customers can open and track support tickets from the portal.' },
  { key: 'enableAssetCheckout', label: 'Asset checkout', description: 'Customers can check devices out and back in.' },
  { key: 'enableSelfService', label: 'Self-service', description: 'Customers can use self-service tools in the portal.' },
  { key: 'enablePasswordReset', label: 'Password reset', description: 'Customers can reset their portal password themselves.' }
];

type OrgPortalSettingsEditorProps = {
  orgId: string;
  onDirty: () => void;
  onSave: () => void;
};

export default function OrgPortalSettingsEditor({ orgId, onDirty, onSave }: OrgPortalSettingsEditorProps) {
  const [draft, setDraft] = useState<PortalSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetchWithAuth(`/orgs/organizations/${orgId}/portal-settings`);
      if (res.status === 401) {
        void navigateTo('/login', { replace: true });
        return;
      }
      if (!res.ok) throw new Error('load failed');
      setDraft((await res.json()).data ?? null);
    } catch {
      setLoadError(true);
    }
    setLoading(false);
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  const update = (patch: Partial<PortalSettings>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    onDirty();
  };

  const save = useCallback(async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/orgs/organizations/${orgId}/portal-settings`, {
          method: 'PATCH',
          body: JSON.stringify({
            enableTickets: draft.enableTickets,
            enableAssetCheckout: draft.enableAssetCheckout,
            enableSelfService: draft.enableSelfService,
            enablePasswordReset: draft.enablePasswordReset,
            supportEmail: draft.supportEmail?.trim() || null,
            supportPhone: draft.supportPhone?.trim() || null,
            welcomeMessage: draft.welcomeMessage?.trim() || null,
            footerText: draft.footerText?.trim() || null
          })
        }),
        errorFallback: 'Failed to save portal settings',
        successMessage: 'Portal settings saved',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      onSave();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setSaving(false);
    }
  }, [draft, saving, orgId, onSave]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading portal settings…</p>;
  }

  if (loadError || !draft) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="org-portal-load-error">
        Portal settings failed to load.{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="org-portal-settings">
      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Portal features</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Control what this customer can do in their portal. Each organization is independent.
        </p>
        <div className="mt-4 space-y-3">
          {TOGGLES.map(({ key, label, description }) => (
            <label key={key} className="flex items-start gap-3 rounded-md border bg-muted/30 p-3">
              <input
                type="checkbox"
                checked={draft[key]}
                onChange={(e) => update({ [key]: e.target.checked } as Partial<PortalSettings>)}
                className="mt-0.5"
                data-testid={`org-portal-toggle-${key}`}
              />
              <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-xs text-muted-foreground">{description}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Support contact</h2>
        <p className="mt-1 text-sm text-muted-foreground">Shown to customers in the portal.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="portal-support-email">Support email</label>
            <input
              id="portal-support-email"
              type="email"
              value={draft.supportEmail ?? ''}
              onChange={(e) => update({ supportEmail: e.target.value })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              data-testid="org-portal-support-email"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="portal-support-phone">Support phone</label>
            <input
              id="portal-support-phone"
              type="tel"
              value={draft.supportPhone ?? ''}
              onChange={(e) => update({ supportPhone: e.target.value })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              data-testid="org-portal-support-phone"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="text-sm font-medium" htmlFor="portal-welcome">Welcome message</label>
            <textarea
              id="portal-welcome"
              rows={3}
              value={draft.welcomeMessage ?? ''}
              onChange={(e) => update({ welcomeMessage: e.target.value })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              data-testid="org-portal-welcome"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="text-sm font-medium" htmlFor="portal-footer">Footer text</label>
            <input
              id="portal-footer"
              value={draft.footerText ?? ''}
              onChange={(e) => update({ footerText: e.target.value })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              data-testid="org-portal-footer"
            />
          </div>
        </div>
      </section>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          data-testid="org-portal-save"
        >
          {saving ? 'Saving…' : 'Save portal settings'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire the tab into OrgSettingsPage**

In `apps/web/src/components/settings/OrgSettingsPage.tsx`:

1. Add `Globe` to the lucide-react import (lines 2–14).
2. After the `OrgBrandingEditor` import (line 15), add:
   ```ts
   import OrgPortalSettingsEditor from './OrgPortalSettingsEditor';
   ```
3. In the `tabs` array, insert after the `branding` entry (line 38):
   ```ts
   {
     id: 'portal',
     label: 'Customer Portal',
     description: 'Portal features and support contact',
     icon: Globe
   },
   ```
4. In `renderContent()`, add a case after `case 'branding'` (line 384):
   ```tsx
   case 'portal':
     return effectiveOrgId ? (
       <OrgPortalSettingsEditor
         orgId={effectiveOrgId}
         onDirty={handleDirty}
         onSave={() => handleSave()}
       />
     ) : null;
   ```
   (`handleSave()` with no args resets the unsaved-changes banner — the editor PATCHes its own endpoint, unlike the JSONB-settings tabs.)

- [ ] **Step 5: Add the new component to the no-silent-mutations targeted set**

In `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, append to `TARGET_GLOBS` (after `'src/components/settings/TicketCategoriesPage.tsx',`):

```ts
  'src/components/settings/OrgPortalSettingsEditor.tsx',
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/settings/OrgPortalSettingsEditor.test.tsx src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS (5 new + guard).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/settings/OrgPortalSettingsEditor.tsx apps/web/src/components/settings/OrgPortalSettingsEditor.test.tsx apps/web/src/components/settings/OrgSettingsPage.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(web): Customer Portal tab on org settings — portal feature toggles + support contact"
```

---

### Task 6: Web — category reorder arrows

**Files:**
- Modify: `apps/web/src/components/settings/TicketCategoriesPage.tsx`
- Modify: `apps/web/src/components/settings/TicketCategoriesPage.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/components/settings/TicketCategoriesPage.test.tsx`. Note `mockGetCategories` (test file line ~48) needs one extra branch — add it inside the `mockImplementation` before the final fallback:

```ts
    if (url === '/ticket-categories/reorder' && init?.method === 'PUT') {
      return makeJsonResponse({ success: true });
    }
```

Then append the new describe blocks:

```tsx
import { moveWithinSiblings } from './TicketCategoriesPage';

describe('moveWithinSiblings', () => {
  const cats = [
    { ...CAT_PARENT, id: 'p1', sortOrder: 0 },          // root
    { ...CAT_ROOT2, id: 'r2', sortOrder: 1 },           // root
    { ...CAT_PARENT, id: 'r3', name: 'Network', sortOrder: 2 }, // root
    { ...CAT_CHILD, id: 'c1', parentId: 'p1', sortOrder: 0 },
    { ...CAT_CHILD, id: 'c2', name: 'Scanners', parentId: 'p1', sortOrder: 1 }
  ];

  it('moves a root down: swaps with the next root only', () => {
    expect(moveWithinSiblings(cats, 'p1', 1)).toEqual(['r2', 'p1', 'r3']);
  });

  it('moves a root up', () => {
    expect(moveWithinSiblings(cats, 'r3', -1)).toEqual(['p1', 'r3', 'r2']);
  });

  it('returns null at the top edge', () => {
    expect(moveWithinSiblings(cats, 'p1', -1)).toBeNull();
  });

  it('returns null at the bottom edge', () => {
    expect(moveWithinSiblings(cats, 'r3', 1)).toBeNull();
  });

  it('children reorder within their own sibling group only', () => {
    expect(moveWithinSiblings(cats, 'c1', 1)).toEqual(['c2', 'c1']);
    expect(moveWithinSiblings(cats, 'c2', 1)).toBeNull();
  });

  it('handles all-tied sortOrder (pre-existing data) using the name tiebreak', () => {
    const tied = [
      { ...CAT_PARENT, id: 'a', name: 'Alpha', sortOrder: 0 },
      { ...CAT_PARENT, id: 'b', name: 'Beta', sortOrder: 0 }
    ];
    expect(moveWithinSiblings(tied, 'b', -1)).toEqual(['b', 'a']);
  });

  it('returns null for an unknown id', () => {
    expect(moveWithinSiblings(cats, 'nope', 1)).toBeNull();
  });
});

describe('reorder buttons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PUTs the sibling-group id order on move-down', async () => {
    mockGetCategories([CAT_PARENT, CAT_ROOT2, CAT_CHILD]);
    render(<TicketCategoriesPage />);
    await waitFor(() => expect(screen.getByTestId('ticket-category-move-down-p1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ticket-category-move-down-p1'));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(putCall).toBeDefined();
      expect(String(putCall![0])).toBe('/ticket-categories/reorder');
      expect(JSON.parse(String(putCall![1]!.body))).toEqual({ ids: ['r2', 'p1'] });
    });
  });

  it('disables the up arrow on the first sibling and down arrow on the last', async () => {
    mockGetCategories([CAT_PARENT, CAT_ROOT2]);
    render(<TicketCategoriesPage />);
    await waitFor(() => expect(screen.getByTestId('ticket-category-move-up-p1')).toBeInTheDocument());
    expect(screen.getByTestId('ticket-category-move-up-p1')).toBeDisabled();
    expect(screen.getByTestId('ticket-category-move-down-p1')).not.toBeDisabled();
    expect(screen.getByTestId('ticket-category-move-down-r2')).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/settings/TicketCategoriesPage.test.tsx`
Expected: FAIL — `moveWithinSiblings` is not exported; testids missing.

- [ ] **Step 3: Implement helper + buttons**

In `apps/web/src/components/settings/TicketCategoriesPage.tsx`:

1. After the `hierarchyOrder` function (ends line 54), add the exported helper:

```ts
// Compute the new id order for `id`'s sibling group (same parentId) after a
// one-step move. Returns null when the move would fall off either edge or the
// id is unknown — callers disable the corresponding arrow on null. Sort matches
// hierarchyOrder's byRank so the visual order and the move order agree even
// when sortOrder values tie (pre-existing rows all start at 0).
export function moveWithinSiblings(cats: Category[], id: string, dir: -1 | 1): string[] | null {
  const target = cats.find((c) => c.id === id);
  if (!target) return null;
  const siblings = cats
    .filter((c) => (c.parentId ?? null) === (target.parentId ?? null))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const idx = siblings.findIndex((c) => c.id === id);
  const swap = idx + dir;
  if (swap < 0 || swap >= siblings.length) return null;
  const order = siblings.map((c) => c.id);
  [order[idx], order[swap]] = [order[swap], order[idx]];
  return order;
}
```

2. Inside the component, after the `saveEdit` callback (ends line 178), add the move handler:

```ts
  const move = useCallback(async (cat: Category, dir: -1 | 1) => {
    const order = moveWithinSiblings(categories, cat.id, dir);
    if (!order) return;
    // Optimistic: apply the new ranks locally; restore server truth on failure.
    const rank = new Map(order.map((id, i) => [id, i]));
    setCategories((prev) => prev.map((c) => (rank.has(c.id) ? { ...c, sortOrder: rank.get(c.id)! } : c)));
    try {
      await runAction({
        request: () => fetchWithAuth('/ticket-categories/reorder', { method: 'PUT', body: JSON.stringify({ ids: order }) }),
        errorFallback: 'Reorder failed. Retry.',
        onUnauthorized: UNAUTHORIZED
      });
    } catch (err) {
      void load();
      if (!(err instanceof ActionError)) throw err;
    }
  }, [categories, load]);
```

3. In the actions cell (`<td className="px-4 py-2 text-right space-x-2">`, line 276), add the two arrow buttons BEFORE the Edit button:

```tsx
                  <button
                    type="button"
                    onClick={() => void move(c, -1)}
                    disabled={moveWithinSiblings(categories, c.id, -1) === null}
                    className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-30"
                    aria-label={`Move ${c.name} up`}
                    data-testid={`ticket-category-move-up-${c.id}`}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => void move(c, 1)}
                    disabled={moveWithinSiblings(categories, c.id, 1) === null}
                    className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-30"
                    aria-label={`Move ${c.name} down`}
                    data-testid={`ticket-category-move-down-${c.id}`}
                  >
                    ▼
                  </button>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/settings/TicketCategoriesPage.test.tsx src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS (all existing + 9 new; the no-silent-mutations guard already covers this file and must stay green).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/TicketCategoriesPage.tsx apps/web/src/components/settings/TicketCategoriesPage.test.tsx
git commit -m "feat(web): up/down reordering for ticket categories (sibling-group sortOrder)"
```

---

### Task 7: Web — create ticket from alert + linked tickets

**Files:**
- Create: `apps/web/src/components/alerts/CreateTicketFromAlertDialog.tsx`
- Create: `apps/web/src/components/alerts/CreateTicketFromAlertDialog.test.tsx`
- Modify: `apps/web/src/components/alerts/AlertDetailPage.tsx`
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (TARGET_GLOBS)
- Modify: `docs/superpowers/specs/2026-06-11-ticketing-operator-gaps-design.md` (deviation note)

**Spec deviation (document it):** the spec says the Create-ticket button is "shown only when the user has `tickets:write`", but the web app has no client-side permission infrastructure (no permissions claim/store — verified). The button renders unconditionally and the API's `requirePermission(TICKETS_WRITE)` enforces; a 403 surfaces as a runAction error toast. Add this sentence to the spec's Feature 2 Web section: *"(Implementation note: the web app has no client-side permission store, so the button renders for everyone and the API's `tickets:write` check enforces — a 403 surfaces as an error toast.)"*

- [ ] **Step 1: Write the failing dialog tests**

Create `apps/web/src/components/alerts/CreateTicketFromAlertDialog.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CreateTicketFromAlertDialog, { SEVERITY_TO_PRIORITY } from './CreateTicketFromAlertDialog';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const ALERT_ID = '5d4c3b2a-1111-4222-8333-444455556666';
const CAT_ID = 'aaaaaaaa-1111-4222-8333-444455556666';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

function mockApi() {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/ticket-categories' && !init?.method) {
      return makeJsonResponse({
        data: [
          { id: CAT_ID, name: 'Hardware', parentId: null, isActive: true, sortOrder: 0 },
          { id: 'inactive-1', name: 'Retired', parentId: null, isActive: false, sortOrder: 1 }
        ]
      });
    }
    if (url === `/alerts/${ALERT_ID}/create-ticket` && init?.method === 'POST') {
      return makeJsonResponse({ data: { id: 't-1', internalNumber: 'T-2026-0099' } }, true, 201);
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
}

const baseProps = {
  alertId: ALERT_ID,
  alertTitle: 'CPU pegged on SRV-01',
  alertSeverity: 'critical',
  openTicketNumber: null as string | null,
  onClose: vi.fn(),
  onCreated: vi.fn()
};

describe('CreateTicketFromAlertDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps severity to priority', () => {
    expect(SEVERITY_TO_PRIORITY.critical).toBe('urgent');
    expect(SEVERITY_TO_PRIORITY.medium).toBe('normal');
    expect(SEVERITY_TO_PRIORITY.info).toBe('low');
  });

  it('prefills subject from the alert title and priority from severity', async () => {
    mockApi();
    render(<CreateTicketFromAlertDialog {...baseProps} />);
    expect((screen.getByTestId('alert-ticket-subject') as HTMLInputElement).value).toBe('CPU pegged on SRV-01');
    expect((screen.getByTestId('alert-ticket-priority') as HTMLSelectElement).value).toBe('urgent');
    // Inactive categories are not offered
    await waitFor(() => expect(screen.getByTestId('alert-ticket-category')).toBeInTheDocument());
    expect(screen.queryByText('Retired')).not.toBeInTheDocument();
  });

  it('POSTs subject/priority/categoryId and calls onCreated', async () => {
    mockApi();
    render(<CreateTicketFromAlertDialog {...baseProps} />);
    await waitFor(() => expect(screen.getByText('Hardware')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('alert-ticket-category'), { target: { value: CAT_ID } });
    fireEvent.click(screen.getByTestId('alert-ticket-submit'));

    await waitFor(() => expect(baseProps.onCreated).toHaveBeenCalled());
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    const body = JSON.parse(String(postCall![1]!.body));
    expect(body).toEqual({ subject: 'CPU pegged on SRV-01', priority: 'urgent', categoryId: CAT_ID });
  });

  it('omits categoryId when none selected', async () => {
    mockApi();
    render(<CreateTicketFromAlertDialog {...baseProps} />);
    fireEvent.click(screen.getByTestId('alert-ticket-submit'));
    await waitFor(() => expect(baseProps.onCreated).toHaveBeenCalled());
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(postCall![1]!.body))).not.toHaveProperty('categoryId');
  });

  it('shows a duplicate warning when an open linked ticket exists (but still allows creating)', async () => {
    mockApi();
    render(<CreateTicketFromAlertDialog {...baseProps} openTicketNumber="T-2026-0042" />);
    expect(screen.getByTestId('alert-ticket-duplicate-warning').textContent).toContain('T-2026-0042');
    expect(screen.getByTestId('alert-ticket-submit')).not.toBeDisabled();
  });

  it('disables submit when the subject is emptied', async () => {
    mockApi();
    render(<CreateTicketFromAlertDialog {...baseProps} />);
    fireEvent.change(screen.getByTestId('alert-ticket-subject'), { target: { value: '   ' } });
    expect(screen.getByTestId('alert-ticket-submit')).toBeDisabled();
  });

  it('does not call onCreated when the POST fails (runAction toasts)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'POST') return makeJsonResponse({ error: 'nope' }, false, 500);
      return makeJsonResponse({ data: [] });
    });
    render(<CreateTicketFromAlertDialog {...baseProps} />);
    fireEvent.click(screen.getByTestId('alert-ticket-submit'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(baseProps.onCreated).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/alerts/CreateTicketFromAlertDialog.test.tsx`
Expected: FAIL — cannot resolve `./CreateTicketFromAlertDialog`.

- [ ] **Step 3: Write the dialog component**

Create `apps/web/src/components/alerts/CreateTicketFromAlertDialog.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '@/lib/runAction';

// Mirrors SEVERITY_TO_PRIORITY in apps/api/src/services/ticketService.ts —
// used only to prefill the select; the server applies the same default when
// priority is omitted, so drift degrades to a different prefill, not a bug.
export const SEVERITY_TO_PRIORITY: Record<string, string> = {
  critical: 'urgent',
  high: 'high',
  medium: 'normal',
  low: 'low',
  info: 'low'
};

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

type CategoryOption = {
  id: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
  sortOrder: number;
};

type CreateTicketFromAlertDialogProps = {
  alertId: string;
  alertTitle: string;
  alertSeverity: string;
  /** internalNumber of an open linked ticket, if one exists — shows a duplicate warning. */
  openTicketNumber: string | null;
  onClose: () => void;
  onCreated: () => void;
};

export default function CreateTicketFromAlertDialog({
  alertId, alertTitle, alertSeverity, openTicketNumber, onClose, onCreated
}: CreateTicketFromAlertDialogProps) {
  const [subject, setSubject] = useState(alertTitle);
  const [priority, setPriority] = useState(SEVERITY_TO_PRIORITY[alertSeverity] ?? 'normal');
  const [categoryId, setCategoryId] = useState('');
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth('/ticket-categories');
        if (!res.ok) return; // category pick is optional — a load failure just hides options
        const data: CategoryOption[] = (await res.json()).data ?? [];
        if (!cancelled) setCategories(data.filter((c) => c.isActive));
      } catch {
        /* optional enrichment only */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const submit = useCallback(async () => {
    if (!subject.trim() || submitting) return;
    setSubmitting(true);
    try {
      await runAction<{ data?: { internalNumber?: string } }>({
        request: () => fetchWithAuth(`/alerts/${alertId}/create-ticket`, {
          method: 'POST',
          body: JSON.stringify({
            subject: subject.trim(),
            priority,
            ...(categoryId ? { categoryId } : {})
          })
        }),
        errorFallback: 'Failed to create ticket',
        successMessage: (r) => r?.data?.internalNumber ? `Ticket ${r.data.internalNumber} created` : 'Ticket created',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      onCreated();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setSubmitting(false);
    }
  }, [subject, priority, categoryId, submitting, alertId, onCreated]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" data-testid="alert-ticket-dialog">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-semibold">Create ticket from alert</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {openTicketNumber && (
          <div
            className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
            data-testid="alert-ticket-duplicate-warning"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>This alert already has open ticket {openTicketNumber}. Creating another is allowed but may duplicate work.</span>
          </div>
        )}

        <div className="mt-4 space-y-3">
          <div>
            <label className="text-sm font-medium" htmlFor="alert-ticket-subject">Subject</label>
            <input
              id="alert-ticket-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={255}
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              data-testid="alert-ticket-subject"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium" htmlFor="alert-ticket-priority">Priority</label>
              <select
                id="alert-ticket-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                data-testid="alert-ticket-priority"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="alert-ticket-category">Category</label>
              <select
                id="alert-ticket-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                data-testid="alert-ticket-category"
              >
                <option value="">None</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.parentId ? `— ${c.name}` : c.name}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm font-medium"
            data-testid="alert-ticket-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!subject.trim() || submitting}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            data-testid="alert-ticket-submit"
          >
            {submitting ? 'Creating…' : 'Create ticket'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run dialog tests to verify they pass**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/alerts/CreateTicketFromAlertDialog.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Wire into AlertDetailPage**

In `apps/web/src/components/alerts/AlertDetailPage.tsx`:

1. Add `Ticket` to the lucide-react import (line 2) and import the dialog after the alertConfig import (line 14):
   ```ts
   import CreateTicketFromAlertDialog from './CreateTicketFromAlertDialog';
   ```
2. Add a linked-ticket type after the `Alert` type (line 32):
   ```ts
   type LinkedTicket = {
     id: string;
     internalNumber: string | null;
     subject: string;
     status: string;
     priority: string;
     linkType: string;
     linkedAt: string;
   };
   ```
3. Add state after `actionInProgress` (line 49):
   ```ts
   const [linkedTickets, setLinkedTickets] = useState<LinkedTicket[]>([]);
   const [linkedError, setLinkedError] = useState(false);
   const [ticketDialogOpen, setTicketDialogOpen] = useState(false);
   ```
4. Add a fetch callback after `fetchAlert` (after line 77) and call it from the existing effect:
   ```ts
   const fetchLinkedTickets = useCallback(async () => {
     try {
       const res = await fetchWithAuth(`/alerts/${alertId}/tickets`);
       if (!res.ok) throw new Error('failed');
       setLinkedTickets((await res.json()).data ?? []);
       setLinkedError(false);
     } catch {
       setLinkedError(true);
     }
   }, [alertId]);
   ```
   And extend the effect (lines 79–81):
   ```ts
   useEffect(() => {
     fetchAlert();
     void fetchLinkedTickets();
   }, [fetchAlert, fetchLinkedTickets]);
   ```
5. In the Actions div (line 217, `<div className="flex gap-2">`), add a Create-ticket button before the Acknowledge button:
   ```tsx
   <button
     type="button"
     onClick={() => setTicketDialogOpen(true)}
     className="h-10 rounded-md border px-4 text-sm font-medium hover:bg-muted"
     data-testid="alert-create-ticket"
   >
     <Ticket className="mr-2 inline-block h-4 w-4" />
     Create ticket
   </button>
   ```
6. After the Alert Message card (ends line 248), add the linked-tickets section:
   ```tsx
   {/* Linked Tickets */}
   {(linkedTickets.length > 0 || linkedError) && (
     <div className="rounded-lg border bg-card p-6 shadow-sm" data-testid="alert-linked-tickets">
       <h3 className="text-sm font-semibold text-muted-foreground mb-3">Linked Tickets</h3>
       {linkedError ? (
         <p className="text-sm text-muted-foreground">
           Linked tickets failed to load.{' '}
           <button type="button" onClick={() => void fetchLinkedTickets()} className="underline hover:text-foreground">Retry</button>
         </p>
       ) : (
         <ul className="space-y-2">
           {linkedTickets.map((t) => (
             <li key={t.id} className="flex items-center justify-between gap-3 text-sm">
               <a href={`/tickets#${t.internalNumber ?? ''}`} className="font-medium hover:underline">
                 {t.internalNumber ?? t.id} — {t.subject}
               </a>
               <span className="rounded-full border px-2 py-0.5 text-xs capitalize text-muted-foreground">
                 {t.status.replace('_', ' ')}
               </span>
             </li>
           ))}
         </ul>
       )}
     </div>
   )}
   ```
7. At the end of the returned JSX (before the final closing `</div>`, line 337), render the dialog:
   ```tsx
   {ticketDialogOpen && (
     <CreateTicketFromAlertDialog
       alertId={alert.id}
       alertTitle={alert.title}
       alertSeverity={alert.severity}
       openTicketNumber={
         linkedTickets.find((t) => !['resolved', 'closed'].includes(t.status))?.internalNumber ?? null
       }
       onClose={() => setTicketDialogOpen(false)}
       onCreated={() => {
         setTicketDialogOpen(false);
         void fetchLinkedTickets();
       }}
     />
   )}
   ```

8. In `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, append to `TARGET_GLOBS`:
   ```ts
   'src/components/alerts/CreateTicketFromAlertDialog.tsx',
   ```
   (Not `AlertDetailPage.tsx` — its legacy acknowledge/resolve handlers predate runAction adoption and migrating them is out of scope.)

9. Apply the spec deviation note (sentence given at the top of this task) to `docs/superpowers/specs/2026-06-11-ticketing-operator-gaps-design.md`, Feature 2 Web section, after the "Create ticket button" bullet.

- [ ] **Step 6: Run tests to verify everything passes**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/alerts/CreateTicketFromAlertDialog.test.tsx src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/alerts/CreateTicketFromAlertDialog.tsx apps/web/src/components/alerts/CreateTicketFromAlertDialog.test.tsx apps/web/src/components/alerts/AlertDetailPage.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts docs/superpowers/specs/2026-06-11-ticketing-operator-gaps-design.md
git commit -m "feat(web): create ticket from alert detail + linked tickets section"
```

---

### Task 8: Final verification

- [ ] **Step 1: Type-check both apps**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```
Expected: only the pre-existing errors in `agents.test.ts` and `apiKeyAuth.test.ts`. Any error in files this plan touched is a regression — fix it.

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit 2>/dev/null || npx astro check
```
(Use whichever check the web app supports; if both are unavailable, the Vitest runs below are the gate.)

- [ ] **Step 2: Run every test file this plan added or touched**

```bash
cd packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/validators/portal.test.ts
cd ../../apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run \
  src/routes/orgPortalSettings.test.ts \
  src/routes/ticketCategories.test.ts \
  src/routes/alerts/alertTickets.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true
cd ../web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run \
  src/components/settings/OrgPortalSettingsEditor.test.tsx \
  src/components/settings/TicketCategoriesPage.test.tsx \
  src/components/alerts/CreateTicketFromAlertDialog.test.tsx \
  src/lib/__tests__/no-silent-mutations.test.ts
```
Expected: all PASS.

- [ ] **Step 3: Verify no stray changes and a clean log**

```bash
git status   # only intended files
git log --oneline main..HEAD
```

- [ ] **Step 4: Done — hand back for review/PR**

Do not push or open a PR without the user's go-ahead. Summarize: endpoints added (`GET/PATCH /orgs/organizations/:id/portal-settings`, `GET /alerts/:id/tickets`, `PUT /ticket-categories/reorder`), UI added (Portal tab, alert Create-ticket dialog + linked tickets, category arrows), and the spec deviation note (web permission gating).
