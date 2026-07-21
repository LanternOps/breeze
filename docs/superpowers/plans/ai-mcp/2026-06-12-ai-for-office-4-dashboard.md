# Breeze AI for Office — Plan 4: MSP Admin Dashboard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the MSP-facing "AI for Office" dashboard section (spec §9): per-org onboarding wizard with Entra admin-consent flow and tenant mapping, full policy editor with DLP rule builder, client-session audit viewer with transcript drill-in and flag/unflag, per-org/per-user usage report with CSV export, and a prompt-template manager — plus the remaining `/client-ai/admin/*` API endpoints those screens need and the client-facing `GET /client-ai/templates` the Plan-5 add-in consumes.

**Architecture:** API side extends the Plan-1 `/client-ai/admin` Hono group (`apps/api/src/routes/clientAi/admin.ts` — group `authMiddleware` + `CLIENT_AI_ENTRA_CLIENT_ID` dark-gate already in place) with four sub-routers (orgs/sessions/usage/templates) mounted onto it, so every new admin route inherits auth + the feature gate. Org access uses `resolveScopedOrgId` (`apps/api/src/routes/c2c/helpers.ts`) → 404, permissions use `PERMISSIONS.ORGS_READ/ORGS_WRITE` (the same pair the technician AI admin routes use, `routes/ai.ts:116-117`), writes audit via `writeRouteAudit`. Web side is one new Astro page (`/ai-for-office`) + a React island tree under `apps/web/src/components/clientAi/`, tabs driven by `window.location.hash` (the `DeviceDetails.tsx:149-166` pattern), every mutation through `runAction`.

**Tech Stack:** Hono, Drizzle, Zod, Vitest (API); Astro + React islands, Tailwind, lucide-react, Vitest + jsdom + @testing-library/react (web)

**Spec:** docs/superpowers/specs/ai-mcp/2026-06-12-breeze-ai-for-office-design.md

**Depends on:** Plans 1–2

---

## Deviations & decisions (validated against the real codebase before writing)

1. **`consentStatus` is derived from `portal_users`, no schema change.** The pinned contract offered two options (a `lastExchangeAt` column on the mapping, or deriving from portal-user existence). Chosen: **derive** — Plan 1's `/auth/exchange` auto-provisions a `portal_users` row with `auth_method='entra'` on the first successful token exchange, so `mapped=false → 'unknown'`, `mapped && no entra users in org → 'pending'`, `mapped && ≥1 entra user → 'granted'`. Zero migrations in this plan; consent state self-heals if a mapping is re-pointed.
2. **Flag/unflag is mirrored, not reused.** The technician handlers (`apps/api/src/routes/ai.ts:285-360`) are inline `db.update(aiSessions)` calls with no extracted service — there is nothing to call. The client-AI handlers mirror them exactly (same columns, same `requireMfa()`, audit actions `client_ai.session.flag`/`client_ai.session.unflag`), constrained to `type='excel_client'`.
3. **Redaction-event metadata is derived from redaction markers.** Plan 3 (DLP) is not yet written; per spec §6 the model and the stored `ai_messages` rows only ever contain the redacted form `[REDACTED:type]`. The transcript endpoint counts `\[REDACTED:([A-Za-z0-9_-]+)\]` markers per message (`countRedactions`, Task 3) instead of depending on a Plan-3 metadata format that doesn't exist yet. If Plan 3 later records structured redaction events, the endpoint can additionally surface them — the UI badge contract (`redactionCounts: Record<string, number>`) stays stable.
4. **The client-facing `GET /client-ai/templates` needs a re-scoped DB context.** Plan 1's `clientAiAuthMiddleware` opens `withDbAccessContext` with `accessiblePartnerIds: []` (Plan 1 Task 10), and `withDbAccessContext` is a no-op when a context is already open (`apps/api/src/db/index.ts:103-105`) — so partner-wide template rows (`org_id NULL`, dual-axis RLS) are **invisible** inside the middleware's context (`breeze_has_partner_access` checks `breeze_accessible_partner_ids()`, `migrations/2026-04-11-a-rls-function-bootstrap.sql:105-115`). The route therefore reads the org's `partner_id` (its own `organizations` row is readable under org scope — id-keyed shape 2), then runs the single template SELECT under `runOutsideDbContext(() => withDbAccessContext({...accessiblePartnerIds: [partnerId]}, ...))` — the narrowest possible grant, read-only, one query, with an explicit `WHERE` on top of RLS. This is NOT a broadening of the middleware: client sessions get the partner axis for this one statement only.
5. **`dlp_config` shape is pinned here and Plan 3 must consume it.** `client_ai_org_policies.dlp_config` is a free `jsonb` (Plan 1). This plan pins the concrete shape (Task 1: `clientAiDlpConfigSchema` — `builtins` map over `creditCard|ssn|iban|apiKey|email|phone` with actions `redact|block|log|off`, plus `customRules: [{id,name,pattern,action}]`, defaults per spec §6: redact for financial/credential types, email/phone off) and tightens Plan 1's `putPolicySchema.dlpConfig` from `z.record(z.unknown())` to it. Plan 1's `admin.test.ts` policy tests don't send `dlpConfig`, so they keep passing. **Coordination note for the Plan-3 implementer: read this shape from Task 1 before writing `clientAiDlp.ts`.**
6. **`GET /client-ai/templates` returns a bare JSON array** (`[{ id, name, description, category, body }]`) — the pinned contract Plan 5 consumes — even though the codebase usually wraps in `{data:[...]}`. Deliberate: the pinned shape wins.
7. **The consent callback is a static confirmation page with no state binding.** Unlike the C2C M365 callback (`apps/api/src/routes/c2c/m365Auth.ts:154` — cookie-bound, exchanges tokens, writes connections), `GET /client-ai/consent/callback` mutates **nothing**: consent state is derived from token exchanges (decision 1), so the callback only tells the admin "you can close this window". No CSRF surface, no cookie, no DB write.
8. **Component tests are implement-then-test.** Explored norm: web components in this repo ship tests alongside (`OrgPortalSettingsEditor.test.tsx`, `BillablesExportCard.test.tsx`) but are not built test-first. API routes in this plan are strict TDD; React components are implemented in full, then covered by the required component tests in the same task.
9. **One endpoint added beyond the pinned list:** `GET /client-ai/admin/orgs/:orgId/users` (the org's `auth_method='entra'` portal users). The policy editor's `userAccess='selected'` picker needs the candidate list (Plan 1 deviation 3: `selected_user_ids` hold `portal_users` UUIDs), and no existing route exposes portal users to partner admins in this shape.
10. **`fetchWithAuth` auto-injects `?orgId=`** from the org store when set (`apps/web/src/stores/auth.ts:406-413`). Every new admin list endpoint therefore treats an `orgId` query param as an access-checked filter rather than rejecting it — same tolerance `routes/ai.ts` admin endpoints and `tickets/export.ts` already have.

## Verification notes for workers

- Node pin: prefix every pnpm/vitest/tsc command with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict).
- The full `vitest run` suite is known-flaky in parallel on a pristine tree — verify with the **affected files only**; trust CI for the full sweep.
- `npx tsc --noEmit` (apps/api) has pre-existing errors in `agents.test.ts` and `apiKeyAuth.test.ts` — those two are not yours.
- Integration tests need the docker test stack: `cd apps/api && pnpm test:docker:up` (postgres 5433 / redis 6380); `src/__tests__/integration/setup.ts` runs `autoMigrate` itself.
- Plans 1–2 are assumed merged: `routes/clientAi/{admin,auth,index,schemas}.ts`, `middleware/clientAiAuth.ts`, `services/clientAiPolicy.ts`, the `clientAi.ts` Drizzle schema, and `ai_sessions.client_user_id` + `type='excel_client'` session rows all exist.
- This plan ships **zero migrations** — all tables come from Plan 1.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `apps/api/src/routes/clientAi/schemas.ts` | Modify | + DLP config schema, template/usage/session query schemas, month regex; tighten `putPolicySchema.dlpConfig` |
| `apps/api/src/routes/clientAi/schemas.test.ts` | Create | Validator coverage for the new schemas |
| `apps/api/src/routes/clientAi/adminOrgs.ts` (+ `.test.ts`) | Create | GET /orgs status list, GET /orgs/:orgId/consent-url, GET /orgs/:orgId/users, public consent callback |
| `apps/api/src/routes/clientAi/adminSessions.ts` (+ `.test.ts`) | Create | Session list/detail/flag/unflag (excel_client only) |
| `apps/api/src/routes/clientAi/adminUsage.ts` (+ `.test.ts`) | Create | Usage report JSON + CSV export |
| `apps/api/src/routes/clientAi/adminTemplates.ts` (+ `.test.ts`) | Create | Template CRUD (org + partner-wide scopes) |
| `apps/api/src/routes/clientAi/templates.ts` (+ `.test.ts`) | Create | Client-facing template list for the add-in (Plan 5 consumer) |
| `apps/api/src/routes/clientAi/admin.ts` | Modify (end) | Mount the four admin sub-routers |
| `apps/api/src/routes/clientAi/index.ts` | Modify | Mount consent callback + client template routes |
| `apps/api/src/__tests__/integration/client-ai-template-routes.integration.test.ts` | Create | Route-level partner-wide insert as `breeze_app` (spec §10 warning) |
| `apps/web/src/pages/ai-for-office.astro` | Create | Page shell (`DashboardLayout` + island) |
| `apps/web/src/components/layout/Sidebar.tsx` | Modify (~line 119) | Nav entry in the "AI & Fleet" section, gated by a new `partnerScopeOnly` NavItem flag |
| `apps/web/src/components/clientAi/AiForOfficePage.tsx` (+ `.test.tsx`) | Create | Hash-tab shell (#orgs, #policy/<orgId>, #sessions, #usage, #templates) |
| `apps/web/src/components/clientAi/OrgsTab.tsx` (+ `.test.tsx`) | Create | Status table + onboarding wizard drawer |
| `apps/web/src/components/clientAi/PolicyEditor.tsx` (+ `.test.tsx`) | Create | Full policy editor incl. DLP builder + live regex test |
| `apps/web/src/components/clientAi/SessionsTab.tsx` (+ `.test.tsx`) | Create | Session audit table + transcript drawer + flag/unflag |
| `apps/web/src/components/clientAi/UsageTab.tsx` (+ `.test.tsx`) | Create | Usage report + CSV download |
| `apps/web/src/components/clientAi/TemplatesTab.tsx` (+ `.test.tsx`) | Create | Template CRUD UI |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | Modify (`TARGET_GLOBS`) | Adopt the four mutating components (OrgsTab, PolicyEditor, SessionsTab, TemplatesTab — UsageTab is GET-only) into the WS-A guard |

---

### Task 1: Shared schema additions — DLP config + query schemas (TDD)

Everything later route tasks import. The DLP shape is the cross-plan contract (decision 5).

**Files:**
- Modify: apps/api/src/routes/clientAi/schemas.ts
- Test: apps/api/src/routes/clientAi/schemas.test.ts

- [ ] **Step 1: Write the failing test**

`apps/api/src/routes/clientAi/schemas.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  clientAiDlpConfigSchema,
  CLIENT_AI_DLP_DEFAULT_BUILTINS,
  adminUsageQuerySchema,
  adminSessionListQuerySchema,
  templateBodySchema,
  templateUpdateSchema,
  USAGE_MONTH_REGEX,
} from './schemas';

describe('clientAiDlpConfigSchema', () => {
  it('accepts the empty object (Plan-1 column default)', () => {
    expect(clientAiDlpConfigSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a full config with builtins and custom rules', () => {
    const result = clientAiDlpConfigSchema.safeParse({
      builtins: { creditCard: 'redact', email: 'off', phone: 'log' },
      customRules: [
        { id: 'r1', name: 'Project codes', pattern: 'PRJ-\\d{4}', action: 'block' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown builtin key', () => {
    expect(
      clientAiDlpConfigSchema.safeParse({ builtins: { dna: 'redact' } }).success
    ).toBe(false);
  });

  it('rejects an unknown action', () => {
    expect(
      clientAiDlpConfigSchema.safeParse({ builtins: { ssn: 'obliterate' } }).success
    ).toBe(false);
  });

  it('rejects a custom rule whose pattern does not compile', () => {
    expect(
      clientAiDlpConfigSchema.safeParse({
        customRules: [{ id: 'r1', name: 'broken', pattern: '([', action: 'redact' }],
      }).success
    ).toBe(false);
  });

  it('pins the spec §6 defaults: redact financial/credential, email/phone off', () => {
    expect(CLIENT_AI_DLP_DEFAULT_BUILTINS).toEqual({
      creditCard: 'redact',
      ssn: 'redact',
      iban: 'redact',
      apiKey: 'redact',
      email: 'off',
      phone: 'off',
    });
  });
});

describe('adminUsageQuerySchema', () => {
  it('accepts a YYYY-MM range', () => {
    expect(adminUsageQuerySchema.safeParse({ from: '2026-01', to: '2026-06' }).success).toBe(true);
  });
  it('rejects a non-month value', () => {
    expect(adminUsageQuerySchema.safeParse({ from: '2026-13', to: '2026-06' }).success).toBe(false);
    expect(adminUsageQuerySchema.safeParse({ from: '2026-01-05', to: '2026-06' }).success).toBe(false);
  });
  it('rejects from > to', () => {
    expect(adminUsageQuerySchema.safeParse({ from: '2026-06', to: '2026-01' }).success).toBe(false);
  });
  it('USAGE_MONTH_REGEX matches only calendar months', () => {
    expect(USAGE_MONTH_REGEX.test('2026-06')).toBe(true);
    expect(USAGE_MONTH_REGEX.test('2026-00')).toBe(false);
  });
});

describe('adminSessionListQuerySchema', () => {
  it('defaults limit/offset and accepts filters', () => {
    const parsed = adminSessionListQuerySchema.parse({
      orgId: '0c0c0c0c-1111-4222-8333-444455556666',
      flagged: 'true',
      from: '2026-06-01',
      to: '2026-06-12T23:59:59Z',
    });
    expect(parsed.limit).toBe(50);
    expect(parsed.offset).toBe(0);
  });
  it('rejects an unparsable date', () => {
    expect(adminSessionListQuerySchema.safeParse({ from: 'yesterday-ish' }).success).toBe(false);
  });
  it('caps limit at 100', () => {
    expect(adminSessionListQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });
});

describe('template schemas', () => {
  it('templateBodySchema accepts an org-scoped body', () => {
    const r = templateBodySchema.safeParse({
      name: 'Variance summary',
      promptBody: 'Explain the variance in the selection.',
      orgId: '0c0c0c0c-1111-4222-8333-444455556666',
    });
    expect(r.success).toBe(true);
  });
  it('templateBodySchema accepts orgId null (partner-wide)', () => {
    expect(
      templateBodySchema.safeParse({ name: 'A', promptBody: 'B', orgId: null }).success
    ).toBe(true);
  });
  it('templateBodySchema is strict', () => {
    expect(
      templateBodySchema.safeParse({ name: 'A', promptBody: 'B', surprise: 1 }).success
    ).toBe(false);
  });
  it('templateUpdateSchema forbids moving scope (no orgId key)', () => {
    expect(templateUpdateSchema.safeParse({ orgId: null }).success).toBe(false);
    expect(templateUpdateSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/schemas.test.ts`
Expected: FAIL — the new exports don't exist yet.

- [ ] **Step 3: Extend `apps/api/src/routes/clientAi/schemas.ts`**

Append after the existing `putPolicySchema` block (and change its `dlpConfig` line):

```ts
// ============================================
// DLP config (spec §6) — THE cross-plan contract shape.
// Stored in client_ai_org_policies.dlp_config (jsonb). The Plan-4 policy
// editor writes it; the Plan-3 clientAiDlp.ts service MUST read this exact
// shape. Absent keys fall back to CLIENT_AI_DLP_DEFAULT_BUILTINS.
// ============================================

export const DLP_BUILTIN_TYPES = ['creditCard', 'ssn', 'iban', 'apiKey', 'email', 'phone'] as const;
export type DlpBuiltinType = (typeof DLP_BUILTIN_TYPES)[number];

export const DLP_ACTIONS = ['redact', 'block', 'log', 'off'] as const;
export type DlpAction = (typeof DLP_ACTIONS)[number];

/** Spec §6 defaults: redact for financial/credential types; email/phone off. */
export const CLIENT_AI_DLP_DEFAULT_BUILTINS: Record<DlpBuiltinType, DlpAction> = {
  creditCard: 'redact',
  ssn: 'redact',
  iban: 'redact',
  apiKey: 'redact',
  email: 'off',
  phone: 'off',
};

export const clientAiDlpCustomRuleSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(100),
    pattern: z
      .string()
      .min(1)
      .max(500)
      .refine((p) => {
        try {
          new RegExp(p);
          return true;
        } catch {
          return false;
        }
      }, 'pattern must be a valid regular expression'),
    action: z.enum(DLP_ACTIONS),
  })
  .strict();

export const clientAiDlpConfigSchema = z
  .object({
    builtins: z.record(z.enum(DLP_BUILTIN_TYPES), z.enum(DLP_ACTIONS)).optional(),
    customRules: z.array(clientAiDlpCustomRuleSchema).max(50).optional(),
  })
  .strict();

export type ClientAiDlpConfig = z.infer<typeof clientAiDlpConfigSchema>;

// ============================================
// Plan-4 admin query/body schemas
// ============================================

export const USAGE_MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

export const adminUsageQuerySchema = z
  .object({
    from: z.string().regex(USAGE_MONTH_REGEX, 'must be YYYY-MM'),
    to: z.string().regex(USAGE_MONTH_REGEX, 'must be YYYY-MM'),
    orgId: z.string().uuid().optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'from must be <= to' });

const parsableDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'must be a parsable date');

export const adminSessionListQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  clientUserId: z.string().uuid().optional(),
  from: parsableDate.optional(),
  to: parsableDate.optional(),
  flagged: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const flagSessionSchema = z
  .object({ reason: z.string().max(1000).optional() })
  .optional();

export const templateBodySchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    promptBody: z.string().min(1).max(20000),
    category: z.string().max(100).nullable().optional(),
    /** null/absent ⇒ partner-wide row (org_id NULL, partner_id set). */
    orgId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const templateUpdateSchema = templateBodySchema
  .omit({ orgId: true })
  .partial()
  .strict();

export const templateListQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  scope: z.enum(['partner', 'org']).optional(),
});
```

And change one line inside the existing `putPolicySchema` (Plan 1):

```ts
    // BEFORE: dlpConfig: z.record(z.unknown()).optional(),
    dlpConfig: clientAiDlpConfigSchema.optional(),
```

(`clientAiDlpConfigSchema` must therefore be declared **above** `putPolicySchema` in the file, or hoist the consts; simplest is to place the whole DLP block before `putPolicySchema` and the query schemas after it.)

- [ ] **Step 4: Run tests to verify they pass — including Plan 1's**

```bash
cd /Users/toddhebebrand/breeze/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/schemas.test.ts src/routes/clientAi/admin.test.ts src/routes/clientAi/auth.test.ts
```

Expected: all PASS (the Plan-1 admin/auth tests prove the `putPolicySchema` tightening broke nothing).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/clientAi/schemas.ts apps/api/src/routes/clientAi/schemas.test.ts
git commit -m "feat(client-ai): DLP config contract schema + Plan-4 admin query schemas" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Admin org status list + consent URL + consent callback (TDD)

The onboarding wizard's API: `GET /orgs` (status table), `GET /orgs/:orgId/consent-url`, `GET /orgs/:orgId/users` (decision 9), and the public consent-callback landing page (decision 7). Tenant-ID pre-fill follows the Plan-1 Task-1 audit recommendation: `m365_connections.tenant_id` first (one per org, `apps/api/src/db/schema/m365.ts:25-46`), falling back to `delegant_m365_connections.m365_tenant_id` (multiple per org possible, `apps/api/src/db/schema/delegant.ts:10-31`) — only GUID-shaped values are suggested.

**Files:**
- Create: apps/api/src/routes/clientAi/adminOrgs.ts
- Test: apps/api/src/routes/clientAi/adminOrgs.test.ts
- Modify: apps/api/src/routes/clientAi/admin.ts (mount, end of file)
- Modify: apps/api/src/routes/clientAi/index.ts (mount callback)

- [ ] **Step 1: Write the failing test**

`apps/api/src/routes/clientAi/adminOrgs.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { dbSelectMock } = vi.hoisted(() => ({ dbSelectMock: vi.fn() }));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      scope: 'partner',
      partnerId: 'f0f0f0f0-1111-4222-8333-444455556666',
      orgId: null,
      accessibleOrgIds: ['0c0c0c0c-1111-4222-8333-444455556666'],
      user: { id: 'ce11ce11-1111-4222-8333-444455556666', email: 'msp@example.com' },
    });
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

vi.mock('../../config/env', () => ({
  CLIENT_AI_ENTRA_CLIENT_ID: '00000000-aaaa-bbbb-cccc-000000000001',
}));

vi.mock('../../db', () => ({ db: { select: dbSelectMock } }));

import {
  clientAiAdminOrgRoutes,
  clientAiConsentCallbackRoute,
  buildClientAiConsentUrl,
  getClientAiConsentRedirectUri,
  currentMonthKey,
} from './adminOrgs';
import { authMiddleware } from '../../middleware/auth';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const OTHER_ORG_ID = '9d9d9d9d-1111-4222-8333-444455556666';
const TID = '6f4f4f4f-1111-4222-8333-444455556666';

/** Flexible thenable Drizzle chain: awaitable after any builder method. */
function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const self = vi.fn(() => c);
  for (const m of ['from', 'where', 'orderBy', 'groupBy', 'leftJoin', 'limit', 'offset']) {
    c[m] = self;
  }
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return c;
}

/** GET /orgs issues 7 selects in a fixed order (see route comment). */
function setupOrgListDb(overrides: Partial<Record<number, unknown[]>> = {}) {
  const defaults: unknown[][] = [
    /* 1 orgs        */ [{ id: ORG_ID, name: 'Contoso Accounting' }],
    /* 2 mappings    */ [{ orgId: ORG_ID, entraTenantId: TID }],
    /* 3 policies    */ [{ orgId: ORG_ID, enabled: true }],
    /* 4 entra users */ [{ orgId: ORG_ID, n: 3 }],
    /* 5 usage       */ [{ orgId: ORG_ID, costCents: '1234.5', messages: '87' }],
    /* 6 m365        */ [{ orgId: ORG_ID, tenantId: TID }],
    /* 7 delegant    */ [],
  ];
  let call = 0;
  dbSelectMock.mockImplementation(() => {
    call++;
    return chain((overrides[call] as unknown[]) ?? defaults[call - 1] ?? []);
  });
}

function buildApp() {
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/client-ai/admin', clientAiAdminOrgRoutes);
  return app;
}

const AUTHED = { Authorization: 'Bearer token' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /client-ai/admin/orgs', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await buildApp().request('/client-ai/admin/orgs');
    expect(res.status).toBe(401);
  });

  it('returns the merged per-org status row', async () => {
    setupOrgListDb();
    const res = await buildApp().request('/client-ai/admin/orgs', { headers: AUTHED });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      orgId: ORG_ID,
      orgName: 'Contoso Accounting',
      mapped: true,
      entraTenantId: TID,
      suggestedEntraTenantId: TID,
      consentStatus: 'granted',
      policyEnabled: true,
      currentMonthCostCents: 1234.5,
      currentMonthMessages: 87,
    });
  });

  it("derives consentStatus 'unknown' when unmapped and 'pending' when mapped without entra users", async () => {
    setupOrgListDb({ 2: [], 4: [] }); // no mapping, no entra users
    let res = await buildApp().request('/client-ai/admin/orgs', { headers: AUTHED });
    expect((await res.json()).data[0].consentStatus).toBe('unknown');

    setupOrgListDb({ 4: [] }); // mapped, no entra users
    res = await buildApp().request('/client-ai/admin/orgs', { headers: AUTHED });
    const row = (await res.json()).data[0];
    expect(row.consentStatus).toBe('pending');
    expect(row.mapped).toBe(true);
  });

  it('honors the orgId filter param (fetchWithAuth auto-injection tolerance)', async () => {
    setupOrgListDb({
      1: [
        { id: ORG_ID, name: 'Contoso Accounting' },
        { id: OTHER_ORG_ID, name: 'Fabrikam' },
      ],
    });
    const res = await buildApp().request(`/client-ai/admin/orgs?orgId=${ORG_ID}`, {
      headers: AUTHED,
    });
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].orgId).toBe(ORG_ID);
  });

  it('suggests the delegant tenant when no m365 connection exists, GUIDs only', async () => {
    setupOrgListDb({
      2: [],
      4: [],
      6: [],
      7: [
        { orgId: ORG_ID, tenantId: 'contoso.onmicrosoft.com' }, // non-GUID — skipped
        { orgId: ORG_ID, tenantId: TID },
      ],
    });
    const res = await buildApp().request('/client-ai/admin/orgs', { headers: AUTHED });
    expect((await res.json()).data[0].suggestedEntraTenantId).toBe(TID);
  });
});

describe('GET /client-ai/admin/orgs/:orgId/consent-url', () => {
  it('404s for an org outside the caller scope', async () => {
    dbSelectMock.mockImplementation(() => chain([]));
    const res = await buildApp().request(
      `/client-ai/admin/orgs/${OTHER_ORG_ID}/consent-url`,
      { headers: AUTHED }
    );
    expect(res.status).toBe(404);
  });

  it('builds a tenant-pinned URL when a mapping exists', async () => {
    dbSelectMock.mockImplementation(() => chain([{ orgId: ORG_ID, entraTenantId: TID }]));
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/consent-url`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const url = new URL(body.url);
    expect(url.pathname).toBe(`/${TID}/adminconsent`);
    expect(url.searchParams.get('client_id')).toBe('00000000-aaaa-bbbb-cccc-000000000001');
    expect(url.searchParams.get('redirect_uri')).toContain('/api/v1/client-ai/consent/callback');
  });

  it("falls back to the 'organizations' segment when unmapped", async () => {
    dbSelectMock.mockImplementation(() => chain([]));
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/consent-url`, {
      headers: AUTHED,
    });
    const body = await res.json();
    expect(new URL(body.url).pathname).toBe('/organizations/adminconsent');
  });
});

describe('GET /client-ai/admin/orgs/:orgId/users', () => {
  it('lists the entra portal users of the org', async () => {
    dbSelectMock.mockImplementation(() =>
      chain([
        { id: 'beefbeef-1111-4222-8333-444455556666', email: 'a@contoso.com', name: 'A', lastLoginAt: null },
      ])
    );
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/users`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].email).toBe('a@contoso.com');
  });

  it('404s outside the caller scope', async () => {
    const res = await buildApp().request(`/client-ai/admin/orgs/${OTHER_ORG_ID}/users`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /client-ai/consent/callback (public)', () => {
  function callbackApp() {
    const app = new Hono();
    app.route('/client-ai', clientAiConsentCallbackRoute);
    return app;
  }

  it('renders the success page when admin_consent=True', async () => {
    const res = await callbackApp().request(
      `/client-ai/consent/callback?admin_consent=True&tenant=${TID}`
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Consent granted');
  });

  it('renders the failure page (escaped) otherwise', async () => {
    const res = await callbackApp().request(
      '/client-ai/consent/callback?error=access_denied&error_description=<script>alert(1)</script>'
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('helpers', () => {
  it('currentMonthKey is YYYY-MM (UTC)', () => {
    expect(currentMonthKey(new Date('2026-06-12T10:00:00Z'))).toBe('2026-06');
    expect(currentMonthKey(new Date('2026-01-01T00:30:00Z'))).toBe('2026-01');
  });
  it('buildClientAiConsentUrl encodes the redirect uri', () => {
    const url = buildClientAiConsentUrl({ clientId: 'cid', entraTenantId: null });
    expect(url).toContain('organizations/adminconsent');
    expect(url).toContain(encodeURIComponent(getClientAiConsentRedirectUri()));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/adminOrgs.test.ts`
Expected: FAIL with module-not-found for `./adminOrgs`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/routes/clientAi/adminOrgs.ts`:

```ts
import { Hono } from 'hono';
import { and, asc, count, eq, sum } from 'drizzle-orm';
import { db } from '../../db';
import {
  clientAiOrgPolicies,
  clientAiTenantMappings,
  clientAiUsage,
} from '../../db/schema/clientAi';
import { organizations } from '../../db/schema/orgs';
import { portalUsers } from '../../db/schema/portal';
import { m365Connections } from '../../db/schema/m365';
import { delegantM365Connections } from '../../db/schema/delegant';
import { requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { CLIENT_AI_ENTRA_CLIENT_ID } from '../../config/env';
import { resolveScopedOrgId } from '../c2c/helpers';
import { ENTRA_TENANT_GUID_REGEX } from './schemas';

/**
 * AI for Office — onboarding/status endpoints for the dashboard OrgsTab
 * (spec §9.1). Mounted onto clientAiAdminRoutes (admin.ts), so the Plan-1
 * group authMiddleware + CLIENT_AI_ENTRA_CLIENT_ID dark-gate already apply.
 *
 * consentStatus derivation (Plan-4 decision 1): the /auth/exchange route
 * (Plan 1) auto-provisions portal_users rows with auth_method='entra' on the
 * first successful token exchange, so
 *   no mapping                       → 'unknown'
 *   mapping, no entra users in org   → 'pending'
 *   mapping + ≥1 entra user          → 'granted'
 */

export const clientAiAdminOrgRoutes = new Hono();

const requireOrgsRead = requirePermission(
  PERMISSIONS.ORGS_READ.resource,
  PERMISSIONS.ORGS_READ.action
);

export function currentMonthKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Mirrors services/c2cM365.ts getCallbackUri() — same env fallbacks. */
export function getClientAiConsentRedirectUri(): string {
  const base = (
    process.env.PUBLIC_URL ||
    process.env.PUBLIC_APP_URL ||
    process.env.DASHBOARD_URL ||
    'http://localhost:3000'
  ).replace(/\/$/, '');
  return `${base}/api/v1/client-ai/consent/callback`;
}

/**
 * Mirrors services/c2cM365.ts buildAdminConsentUrl(), but with the tenant
 * segment pinned by the spec: the mapped tenant GUID when known, otherwise
 * the 'organizations' multi-tenant endpoint.
 */
export function buildClientAiConsentUrl(params: {
  clientId: string;
  entraTenantId: string | null;
}): string {
  const segment = params.entraTenantId ?? 'organizations';
  const url = new URL(`https://login.microsoftonline.com/${segment}/adminconsent`);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', getClientAiConsentRedirectUri());
  return url.toString();
}

// ── GET /orgs — per-org status list ──────────────────────────────────────────
// Seven sequential selects, merged in JS (no N+1; each is one indexed scan).
// Order matters — the unit test mocks them positionally:
//   1 organizations  2 tenant mappings  3 policies  4 entra-user counts
//   5 current-month usage  6 m365 connections  7 delegant connections
clientAiAdminOrgRoutes.get('/orgs', requireOrgsRead, async (c) => {
  const orgFilter = c.req.query('orgId') || null;

  const orgs = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .orderBy(asc(organizations.name));

  const mappings = await db
    .select({
      orgId: clientAiTenantMappings.orgId,
      entraTenantId: clientAiTenantMappings.entraTenantId,
    })
    .from(clientAiTenantMappings);

  const policies = await db
    .select({ orgId: clientAiOrgPolicies.orgId, enabled: clientAiOrgPolicies.enabled })
    .from(clientAiOrgPolicies);

  const entraUsers = await db
    .select({ orgId: portalUsers.orgId, n: count() })
    .from(portalUsers)
    .where(eq(portalUsers.authMethod, 'entra'))
    .groupBy(portalUsers.orgId);

  const usage = await db
    .select({
      orgId: clientAiUsage.orgId,
      costCents: sum(clientAiUsage.totalCostCents),
      messages: sum(clientAiUsage.messageCount),
    })
    .from(clientAiUsage)
    .where(
      and(eq(clientAiUsage.period, 'monthly'), eq(clientAiUsage.periodKey, currentMonthKey()))
    )
    .groupBy(clientAiUsage.orgId);

  const m365 = await db
    .select({ orgId: m365Connections.orgId, tenantId: m365Connections.tenantId })
    .from(m365Connections);

  const delegant = await db
    .select({
      orgId: delegantM365Connections.orgId,
      tenantId: delegantM365Connections.m365TenantId,
    })
    .from(delegantM365Connections);

  const mappingByOrg = new Map(mappings.map((m) => [m.orgId, m.entraTenantId]));
  const policyByOrg = new Map(policies.map((p) => [p.orgId, p.enabled === true]));
  const entraCountByOrg = new Map(entraUsers.map((u) => [u.orgId, Number(u.n ?? 0)]));
  const usageByOrg = new Map(
    usage.map((u) => [
      u.orgId,
      {
        costCents: Math.round(Number(u.costCents ?? 0) * 100) / 100,
        messages: Number(u.messages ?? 0),
      },
    ])
  );
  // Pre-fill preference per the Plan-1 Task-1 M365 reuse audit:
  // m365_connections.tenant_id first (one per org), then the first GUID-shaped
  // delegant_m365_connections.m365_tenant_id. Non-GUID values never suggested.
  const suggestedByOrg = new Map<string, string>();
  for (const row of delegant) {
    if (!suggestedByOrg.has(row.orgId) && ENTRA_TENANT_GUID_REGEX.test(row.tenantId)) {
      suggestedByOrg.set(row.orgId, row.tenantId.toLowerCase());
    }
  }
  for (const row of m365) {
    if (ENTRA_TENANT_GUID_REGEX.test(row.tenantId)) {
      suggestedByOrg.set(row.orgId, row.tenantId.toLowerCase());
    }
  }

  const data = orgs
    .filter((org) => !orgFilter || org.id === orgFilter)
    .map((org) => {
      const entraTenantId = mappingByOrg.get(org.id) ?? null;
      const mapped = entraTenantId !== null;
      const granted = mapped && (entraCountByOrg.get(org.id) ?? 0) > 0;
      const orgUsage = usageByOrg.get(org.id);
      return {
        orgId: org.id,
        orgName: org.name,
        mapped,
        entraTenantId,
        suggestedEntraTenantId: suggestedByOrg.get(org.id) ?? null,
        consentStatus: !mapped ? ('unknown' as const) : granted ? ('granted' as const) : ('pending' as const),
        policyEnabled: policyByOrg.get(org.id) ?? false,
        currentMonthCostCents: orgUsage?.costCents ?? 0,
        currentMonthMessages: orgUsage?.messages ?? 0,
      };
    });

  return c.json({ data });
});

// ── GET /orgs/:orgId/consent-url ──────────────────────────────────────────────
clientAiAdminOrgRoutes.get('/orgs/:orgId/consent-url', requireOrgsRead, async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.param('orgId'));
  if (!orgId) return c.json({ error: 'Organization not found' }, 404);

  const [mapping] = await db
    .select({ entraTenantId: clientAiTenantMappings.entraTenantId })
    .from(clientAiTenantMappings)
    .where(eq(clientAiTenantMappings.orgId, orgId))
    .limit(1);

  const entraTenantId = mapping?.entraTenantId ?? null;
  return c.json({
    url: buildClientAiConsentUrl({ clientId: CLIENT_AI_ENTRA_CLIENT_ID, entraTenantId }),
    tenantSegment: entraTenantId ?? 'organizations',
    redirectUri: getClientAiConsentRedirectUri(),
  });
});

// ── GET /orgs/:orgId/users — entra portal users (policy-editor picker) ───────
clientAiAdminOrgRoutes.get('/orgs/:orgId/users', requireOrgsRead, async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.param('orgId'));
  if (!orgId) return c.json({ error: 'Organization not found' }, 404);

  const data = await db
    .select({
      id: portalUsers.id,
      email: portalUsers.email,
      name: portalUsers.name,
      lastLoginAt: portalUsers.lastLoginAt,
    })
    .from(portalUsers)
    .where(and(eq(portalUsers.orgId, orgId), eq(portalUsers.authMethod, 'entra')))
    .orderBy(asc(portalUsers.email));

  return c.json({ data });
});

// ── Public consent-callback landing page ─────────────────────────────────────
// Registered Redirect URI of the add-in app registration. Mutates NOTHING
// (decision 7): consent state is derived from token exchanges, so unlike the
// C2C callback (routes/c2c/m365Auth.ts:154) there is no cookie/state binding,
// no token exchange, no DB write — just a human-readable confirmation.
export const clientAiConsentCallbackRoute = new Hono();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

clientAiConsentCallbackRoute.get('/consent/callback', (c) => {
  const granted = (c.req.query('admin_consent') ?? '').toLowerCase() === 'true';
  const error = c.req.query('error') ?? '';
  const description = c.req.query('error_description') ?? '';
  const title = granted ? 'Consent granted' : 'Consent not granted';
  const detail = granted
    ? 'You can close this window, return to Breeze, and click “I’ve granted consent” in the setup wizard.'
    : escapeHtml(description || error || 'Microsoft did not report a granted consent. Close this window and retry from Breeze.');
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title} — Breeze AI for Office</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b0f17;color:#e5e7eb}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem}p{color:#9ca3af;font-size:.9rem;line-height:1.5}</style>
</head>
<body><main><h1>${title}</h1><p>${detail}</p></main></body>
</html>`;
  return c.html(html, granted ? 200 : 400);
});
```

- [ ] **Step 4: Mount — `admin.ts` and `index.ts`**

Append to `apps/api/src/routes/clientAi/admin.ts` (after the policy routes; the group `use('*', authMiddleware)` + dark-gate at the top of the file apply to sub-routers mounted afterwards):

```ts
import { clientAiAdminOrgRoutes } from './adminOrgs';

// ── Plan-4 dashboard sub-routers (inherit group auth + dark-gate above) ──────
clientAiAdminRoutes.route('/', clientAiAdminOrgRoutes);
```

(Place the import with the other imports at the top of the file; the `.route` call at the very end.)

In `apps/api/src/routes/clientAi/index.ts`, add the public callback route:

```ts
import { clientAiConsentCallbackRoute } from './adminOrgs';

// Public Entra admin-consent landing page (no auth — informational only).
clientAiRoutes.route('/', clientAiConsentCallbackRoute);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/adminOrgs.test.ts src/routes/clientAi/admin.test.ts`
Expected: all PASS (admin.test.ts re-run proves the mount edit broke nothing).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/clientAi/adminOrgs.ts apps/api/src/routes/clientAi/adminOrgs.test.ts apps/api/src/routes/clientAi/admin.ts apps/api/src/routes/clientAi/index.ts
git commit -m "feat(client-ai): admin org status list, consent-url helper + public consent callback" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Admin session audit routes — list, transcript, flag/unflag (TDD)

The audit viewer's API (spec §9.3). Mirrors the technician flag/unflag handlers (`apps/api/src/routes/ai.ts:285-360` — decision 2) and the admin session list (`routes/ai.ts:883-906`), constrained to `type='excel_client'` with org/user/date/flagged filters and `organizations`/`portal_users` joins.

**Files:**
- Create: apps/api/src/routes/clientAi/adminSessions.ts
- Test: apps/api/src/routes/clientAi/adminSessions.test.ts
- Modify: apps/api/src/routes/clientAi/admin.ts (mount)

- [ ] **Step 1: Write the failing test**

`apps/api/src/routes/clientAi/adminSessions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { dbSelectMock, dbUpdateMock, writeRouteAuditMock } = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  dbUpdateMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      scope: 'partner',
      partnerId: 'f0f0f0f0-1111-4222-8333-444455556666',
      orgId: null,
      accessibleOrgIds: ['0c0c0c0c-1111-4222-8333-444455556666'],
      canAccessOrg: (id: string) => id === '0c0c0c0c-1111-4222-8333-444455556666',
      user: { id: 'ce11ce11-1111-4222-8333-444455556666', email: 'msp@example.com' },
    });
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

vi.mock('../../config/env', () => ({
  CLIENT_AI_ENTRA_CLIENT_ID: '00000000-aaaa-bbbb-cccc-000000000001',
}));

vi.mock('../../db', () => ({ db: { select: dbSelectMock, update: dbUpdateMock } }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

import { clientAiAdminSessionRoutes, countRedactions } from './adminSessions';
import { authMiddleware } from '../../middleware/auth';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const OTHER_ORG_ID = '9d9d9d9d-1111-4222-8333-444455556666';
const SESSION_ID = '5e5e5e5e-1111-4222-8333-444455556666';
const CLIENT_USER_ID = 'beefbeef-1111-4222-8333-444455556666';

const SESSION_ROW = {
  id: SESSION_ID,
  orgId: ORG_ID,
  orgName: 'Contoso Accounting',
  clientUserId: CLIENT_USER_ID,
  userEmail: 'finance.user@contoso.com',
  title: 'Q3 budget review',
  model: 'claude-sonnet-4-5-20250929',
  status: 'closed',
  type: 'excel_client',
  turnCount: 6,
  totalCostCents: 12.5,
  totalInputTokens: 4000,
  totalOutputTokens: 900,
  flaggedAt: null,
  flaggedBy: null,
  flagReason: null,
  createdAt: new Date('2026-06-10T09:00:00Z'),
  lastActivityAt: new Date('2026-06-10T09:20:00Z'),
};

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const self = vi.fn(() => c);
  for (const m of ['from', 'where', 'orderBy', 'groupBy', 'leftJoin', 'limit', 'offset']) {
    c[m] = self;
  }
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return c;
}

function buildApp() {
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/client-ai/admin', clientAiAdminSessionRoutes);
  return app;
}

const AUTHED = { Authorization: 'Bearer token', 'Content-Type': 'application/json' };

beforeEach(() => {
  vi.clearAllMocks();
  dbUpdateMock.mockImplementation(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  }));
});

describe('GET /client-ai/admin/sessions', () => {
  it('returns rows + pagination (query 1 = rows, query 2 = count)', async () => {
    let call = 0;
    dbSelectMock.mockImplementation(() => {
      call++;
      return call === 1 ? chain([SESSION_ROW]) : chain([{ n: 1 }]);
    });
    const res = await buildApp().request('/client-ai/admin/sessions?flagged=false', {
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0]).toMatchObject({
      id: SESSION_ID,
      orgName: 'Contoso Accounting',
      userEmail: 'finance.user@contoso.com',
      turnCount: 6,
      totalCostCents: 12.5,
    });
    expect(body.data[0].startedAt).toBeDefined();
    expect(body.pagination).toMatchObject({ total: 1, limit: 50, offset: 0 });
  });

  it('404s an orgId filter outside the caller scope (no existence oracle)', async () => {
    const res = await buildApp().request(
      `/client-ai/admin/sessions?orgId=${OTHER_ORG_ID}`,
      { headers: AUTHED }
    );
    expect(res.status).toBe(404);
  });

  it('400s an unparsable date filter', async () => {
    const res = await buildApp().request('/client-ai/admin/sessions?from=not-a-date', {
      headers: AUTHED,
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /client-ai/admin/sessions/:id', () => {
  it('returns transcript with redaction counts and tool trail', async () => {
    let call = 0;
    dbSelectMock.mockImplementation(() => {
      call++;
      if (call === 1) return chain([SESSION_ROW]);
      if (call === 2)
        return chain([
          {
            id: 'm1',
            role: 'user',
            content: 'Card [REDACTED:creditCard] and [REDACTED:creditCard], ssn [REDACTED:ssn]',
            contentBlocks: null,
            toolName: null,
            toolInput: null,
            toolOutput: null,
            createdAt: new Date(),
          },
        ]);
      return chain([
        {
          id: 't1',
          toolName: 'write_range',
          toolInput: { range: 'B2:B4' },
          status: 'completed',
          approvedBy: null,
          approvedAt: new Date(),
          errorMessage: null,
          durationMs: 240,
          createdAt: new Date(),
          completedAt: new Date(),
        },
      ]);
    });
    const res = await buildApp().request(`/client-ai/admin/sessions/${SESSION_ID}`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.id).toBe(SESSION_ID);
    expect(body.messages[0].redactionCounts).toEqual({ creditCard: 2, ssn: 1 });
    expect(body.toolExecutions[0].toolName).toBe('write_range');
  });

  it('404s when the session does not exist / is not excel_client', async () => {
    dbSelectMock.mockImplementation(() => chain([]));
    const res = await buildApp().request(`/client-ai/admin/sessions/${SESSION_ID}`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(404);
  });

  it('404s a session in an inaccessible org (belt-and-braces over RLS)', async () => {
    dbSelectMock.mockImplementation(() => chain([{ ...SESSION_ROW, orgId: OTHER_ORG_ID }]));
    const res = await buildApp().request(`/client-ai/admin/sessions/${SESSION_ID}`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(404);
  });
});

describe('flag / unflag', () => {
  it('POST flags with a reason and audits', async () => {
    dbSelectMock.mockImplementation(() => chain([SESSION_ROW]));
    const res = await buildApp().request(
      `/client-ai/admin/sessions/${SESSION_ID}/flag`,
      { method: 'POST', headers: AUTHED, body: JSON.stringify({ reason: 'PII concern' }) }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(dbUpdateMock).toHaveBeenCalled();
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        action: 'client_ai.session.flag',
        resourceType: 'ai_session',
        resourceId: SESSION_ID,
      })
    );
  });

  it('POST accepts an empty body', async () => {
    dbSelectMock.mockImplementation(() => chain([SESSION_ROW]));
    const res = await buildApp().request(
      `/client-ai/admin/sessions/${SESSION_ID}/flag`,
      { method: 'POST', headers: AUTHED }
    );
    expect(res.status).toBe(200);
  });

  it('DELETE unflags and audits', async () => {
    dbSelectMock.mockImplementation(() =>
      chain([{ ...SESSION_ROW, flaggedAt: new Date(), flagReason: 'old' }])
    );
    const res = await buildApp().request(
      `/client-ai/admin/sessions/${SESSION_ID}/flag`,
      { method: 'DELETE', headers: AUTHED }
    );
    expect(res.status).toBe(200);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'client_ai.session.unflag' })
    );
  });

  it('404s flagging a missing session', async () => {
    dbSelectMock.mockImplementation(() => chain([]));
    const res = await buildApp().request(
      `/client-ai/admin/sessions/${SESSION_ID}/flag`,
      { method: 'POST', headers: AUTHED }
    );
    expect(res.status).toBe(404);
  });
});

describe('countRedactions', () => {
  it('counts markers per type and tolerates null', () => {
    expect(countRedactions(null)).toEqual({});
    expect(countRedactions('[REDACTED:iban] x [REDACTED:iban] [REDACTED:apiKey]')).toEqual({
      iban: 2,
      apiKey: 1,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/adminSessions.test.ts`
Expected: FAIL with module-not-found for `./adminSessions`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/routes/clientAi/adminSessions.ts`:

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, count, desc, eq, gte, isNotNull, isNull, lte, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { aiSessions, aiMessages, aiToolExecutions } from '../../db/schema';
import { organizations } from '../../db/schema/orgs';
import { portalUsers } from '../../db/schema/portal';
import { requireMfa, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { resolveScopedOrgId } from '../c2c/helpers';
import { adminSessionListQuerySchema, flagSessionSchema } from './schemas';

/**
 * AI for Office — client-session audit viewer endpoints (spec §9.3).
 * excel_client sessions ONLY; technician sessions stay on /ai/admin/*.
 *
 * Flag/unflag mirrors the technician handlers (routes/ai.ts:285-360) — those
 * are inline db.updates with no shared service, so there is nothing to call
 * (Plan-4 decision 2). Same MFA gate, audit actions namespaced client_ai.*.
 *
 * Redaction badges (Plan-4 decision 3): ai_messages stores the redacted form
 * (spec §6 "redact before logging"), so redaction-event metadata is DERIVED
 * by counting [REDACTED:type] markers — no dependency on a Plan-3 metadata
 * format that does not exist yet.
 */

export const clientAiAdminSessionRoutes = new Hono();

const requireOrgsRead = requirePermission(
  PERMISSIONS.ORGS_READ.resource,
  PERMISSIONS.ORGS_READ.action
);
const requireOrgsWrite = requirePermission(
  PERMISSIONS.ORGS_WRITE.resource,
  PERMISSIONS.ORGS_WRITE.action
);

export const REDACTION_MARKER_REGEX = /\[REDACTED:([A-Za-z0-9_-]+)\]/g;

export function countRedactions(text: string | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!text) return counts;
  for (const match of text.matchAll(REDACTION_MARKER_REGEX)) {
    const key = match[1]!;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

type SessionAuth = {
  canAccessOrg?: (orgId: string) => boolean;
  user?: { id: string };
};

const sessionSelection = {
  id: aiSessions.id,
  orgId: aiSessions.orgId,
  orgName: organizations.name,
  clientUserId: aiSessions.clientUserId,
  userEmail: portalUsers.email,
  title: aiSessions.title,
  model: aiSessions.model,
  status: aiSessions.status,
  turnCount: aiSessions.turnCount,
  totalCostCents: aiSessions.totalCostCents,
  totalInputTokens: aiSessions.totalInputTokens,
  totalOutputTokens: aiSessions.totalOutputTokens,
  flaggedAt: aiSessions.flaggedAt,
  flaggedBy: aiSessions.flaggedBy,
  flagReason: aiSessions.flagReason,
  createdAt: aiSessions.createdAt,
  lastActivityAt: aiSessions.lastActivityAt,
};

// ── GET /sessions — filtered, paginated list ─────────────────────────────────
clientAiAdminSessionRoutes.get(
  '/sessions',
  requireOrgsRead,
  zValidator('query', adminSessionListQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const q = c.req.valid('query');

    const conditions: SQL[] = [eq(aiSessions.type, 'excel_client')];
    if (q.orgId) {
      const orgId = resolveScopedOrgId(auth, q.orgId);
      if (!orgId) return c.json({ error: 'Organization not found' }, 404);
      conditions.push(eq(aiSessions.orgId, orgId));
    }
    if (q.clientUserId) conditions.push(eq(aiSessions.clientUserId, q.clientUserId));
    if (q.from) conditions.push(gte(aiSessions.createdAt, new Date(q.from)));
    if (q.to) conditions.push(lte(aiSessions.createdAt, new Date(q.to)));
    if (q.flagged === 'true') conditions.push(isNotNull(aiSessions.flaggedAt));
    if (q.flagged === 'false') conditions.push(isNull(aiSessions.flaggedAt));

    const where = and(...conditions);

    const rows = await db
      .select(sessionSelection)
      .from(aiSessions)
      .leftJoin(organizations, eq(aiSessions.orgId, organizations.id))
      .leftJoin(portalUsers, eq(aiSessions.clientUserId, portalUsers.id))
      .where(where)
      .orderBy(desc(aiSessions.createdAt))
      .limit(q.limit)
      .offset(q.offset);

    const [totalRow] = await db.select({ n: count() }).from(aiSessions).where(where);

    return c.json({
      data: rows.map((r) => ({
        id: r.id,
        orgId: r.orgId,
        orgName: r.orgName ?? null,
        clientUserId: r.clientUserId,
        userEmail: r.userEmail ?? null,
        title: r.title,
        startedAt: r.createdAt,
        lastActivityAt: r.lastActivityAt,
        turnCount: r.turnCount,
        totalCostCents: r.totalCostCents,
        flaggedAt: r.flaggedAt,
        flagReason: r.flagReason,
        status: r.status,
      })),
      pagination: { total: Number(totalRow?.n ?? 0), limit: q.limit, offset: q.offset },
    });
  }
);

/** Fetch one excel_client session the caller can access, else null. */
async function getClientSession(auth: SessionAuth, sessionId: string) {
  const [row] = await db
    .select(sessionSelection)
    .from(aiSessions)
    .leftJoin(organizations, eq(aiSessions.orgId, organizations.id))
    .leftJoin(portalUsers, eq(aiSessions.clientUserId, portalUsers.id))
    .where(and(eq(aiSessions.id, sessionId), eq(aiSessions.type, 'excel_client')))
    .limit(1);
  if (!row) return null;
  // RLS already scopes the SELECT; this is the belt-and-braces app-layer
  // check the technician routes also perform via getSession(sessionId, auth).
  if (auth.canAccessOrg && !auth.canAccessOrg(row.orgId)) return null;
  return row;
}

// ── GET /sessions/:id — full transcript ──────────────────────────────────────
clientAiAdminSessionRoutes.get('/sessions/:id', requireOrgsRead, async (c) => {
  const auth = c.get('auth') as SessionAuth;
  const session = await getClientSession(auth, c.req.param('id'));
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const messages = await db
    .select({
      id: aiMessages.id,
      role: aiMessages.role,
      content: aiMessages.content,
      contentBlocks: aiMessages.contentBlocks,
      toolName: aiMessages.toolName,
      toolInput: aiMessages.toolInput,
      toolOutput: aiMessages.toolOutput,
      createdAt: aiMessages.createdAt,
    })
    .from(aiMessages)
    .where(eq(aiMessages.sessionId, session.id))
    .orderBy(asc(aiMessages.createdAt));

  const toolExecutions = await db
    .select({
      id: aiToolExecutions.id,
      toolName: aiToolExecutions.toolName,
      toolInput: aiToolExecutions.toolInput,
      status: aiToolExecutions.status,
      approvedBy: aiToolExecutions.approvedBy,
      approvedAt: aiToolExecutions.approvedAt,
      errorMessage: aiToolExecutions.errorMessage,
      durationMs: aiToolExecutions.durationMs,
      createdAt: aiToolExecutions.createdAt,
      completedAt: aiToolExecutions.completedAt,
    })
    .from(aiToolExecutions)
    .where(eq(aiToolExecutions.sessionId, session.id))
    .orderBy(asc(aiToolExecutions.createdAt));

  return c.json({
    session,
    messages: messages.map((m) => ({ ...m, redactionCounts: countRedactions(m.content) })),
    toolExecutions,
  });
});

// ── POST /sessions/:id/flag ───────────────────────────────────────────────────
clientAiAdminSessionRoutes.post(
  '/sessions/:id/flag',
  requireOrgsWrite,
  requireMfa(),
  zValidator('json', flagSessionSchema),
  async (c) => {
    const auth = c.get('auth') as SessionAuth;
    const session = await getClientSession(auth, c.req.param('id'));
    if (!session) return c.json({ error: 'Session not found' }, 404);

    const body = c.req.valid('json') ?? {};

    await db
      .update(aiSessions)
      .set({
        flaggedAt: new Date(),
        flaggedBy: auth.user?.id ?? null,
        flagReason: body.reason ?? null,
      })
      .where(eq(aiSessions.id, session.id));

    writeRouteAudit(c, {
      orgId: session.orgId,
      action: 'client_ai.session.flag',
      resourceType: 'ai_session',
      resourceId: session.id,
      details: { reason: body.reason ?? null },
    });

    return c.json({ success: true });
  }
);

// ── DELETE /sessions/:id/flag ─────────────────────────────────────────────────
clientAiAdminSessionRoutes.delete(
  '/sessions/:id/flag',
  requireOrgsWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth') as SessionAuth;
    const session = await getClientSession(auth, c.req.param('id'));
    if (!session) return c.json({ error: 'Session not found' }, 404);

    await db
      .update(aiSessions)
      .set({ flaggedAt: null, flaggedBy: null, flagReason: null })
      .where(eq(aiSessions.id, session.id));

    writeRouteAudit(c, {
      orgId: session.orgId,
      action: 'client_ai.session.unflag',
      resourceType: 'ai_session',
      resourceId: session.id,
    });

    return c.json({ success: true });
  }
);
```

Note: the empty-body POST works because `flagSessionSchema` is `.optional()` — same shape as the technician route's `zValidator('json', z.object({...}).optional())` (`routes/ai.ts:291`). If `zValidator` rejects a missing JSON body on this Hono version, mirror ai.ts exactly (it already handles this in production).

- [ ] **Step 4: Mount in `admin.ts`**

```ts
import { clientAiAdminSessionRoutes } from './adminSessions';
// ...
clientAiAdminRoutes.route('/', clientAiAdminSessionRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/adminSessions.test.ts`
Expected: 12 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/clientAi/adminSessions.ts apps/api/src/routes/clientAi/adminSessions.test.ts apps/api/src/routes/clientAi/admin.ts
git commit -m "feat(client-ai): admin session audit routes — list, transcript, flag/unflag" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Admin usage report + CSV export (TDD)

Spec §8/§9.4: aggregate `client_ai_usage` monthly buckets per org/user, JSON for the dashboard table and `text/csv` for the MSP's invoicing artifact. CSV building follows `apps/api/src/routes/tickets/export.ts` (`csvRow` from `services/spreadsheetExport.ts` — formula-neutralized, quoted cells); the export is audited like `routes/auditLogs.ts:790-803`.

**Files:**
- Create: apps/api/src/routes/clientAi/adminUsage.ts
- Test: apps/api/src/routes/clientAi/adminUsage.test.ts
- Modify: apps/api/src/routes/clientAi/admin.ts (mount)

- [ ] **Step 1: Write the failing test**

`apps/api/src/routes/clientAi/adminUsage.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { dbSelectMock, writeRouteAuditMock } = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      scope: 'partner',
      partnerId: 'f0f0f0f0-1111-4222-8333-444455556666',
      orgId: null,
      accessibleOrgIds: ['0c0c0c0c-1111-4222-8333-444455556666'],
      user: { id: 'ce11ce11-1111-4222-8333-444455556666', email: 'msp@example.com' },
    });
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

vi.mock('../../config/env', () => ({
  CLIENT_AI_ENTRA_CLIENT_ID: '00000000-aaaa-bbbb-cccc-000000000001',
}));

vi.mock('../../db', () => ({ db: { select: dbSelectMock } }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

import { clientAiAdminUsageRoutes } from './adminUsage';
import { authMiddleware } from '../../middleware/auth';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const OTHER_ORG_ID = '9d9d9d9d-1111-4222-8333-444455556666';

const USAGE_ROWS = [
  {
    periodKey: '2026-05',
    orgId: ORG_ID,
    orgName: 'Contoso Accounting',
    clientUserId: 'beefbeef-1111-4222-8333-444455556666',
    userEmail: 'finance.user@contoso.com',
    inputTokens: 10000,
    outputTokens: 2000,
    totalCostCents: 150.4,
    sessionCount: 4,
    messageCount: 40,
  },
  {
    periodKey: '2026-06',
    orgId: ORG_ID,
    orgName: 'Contoso Accounting',
    clientUserId: 'cafecafe-1111-4222-8333-444455556666',
    userEmail: 'ap.clerk@contoso.com',
    inputTokens: 5000,
    outputTokens: 1000,
    totalCostCents: 75.1,
    sessionCount: 2,
    messageCount: 18,
  },
];

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const self = vi.fn(() => c);
  for (const m of ['from', 'where', 'orderBy', 'groupBy', 'leftJoin', 'limit', 'offset']) {
    c[m] = self;
  }
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return c;
}

function buildApp() {
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/client-ai/admin', clientAiAdminUsageRoutes);
  return app;
}

const AUTHED = { Authorization: 'Bearer token' };

beforeEach(() => {
  vi.clearAllMocks();
  dbSelectMock.mockImplementation(() => chain(USAGE_ROWS));
});

describe('GET /client-ai/admin/usage', () => {
  it('400s a missing/invalid month range', async () => {
    expect((await buildApp().request('/client-ai/admin/usage', { headers: AUTHED })).status).toBe(400);
    expect(
      (
        await buildApp().request('/client-ai/admin/usage?from=2026-06-01&to=2026-06', {
          headers: AUTHED,
        })
      ).status
    ).toBe(400);
  });

  it('returns per-user rows and computed totals', async () => {
    const res = await buildApp().request(
      '/client-ai/admin/usage?from=2026-05&to=2026-06',
      { headers: AUTHED }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toMatchObject({
      month: '2026-05',
      orgName: 'Contoso Accounting',
      userEmail: 'finance.user@contoso.com',
      costCents: 150.4,
    });
    expect(body.totals).toMatchObject({
      messageCount: 58,
      sessionCount: 6,
      inputTokens: 15000,
      outputTokens: 3000,
      costCents: 225.5,
    });
  });

  it('404s an orgId outside the caller scope', async () => {
    const res = await buildApp().request(
      `/client-ai/admin/usage?from=2026-05&to=2026-06&orgId=${OTHER_ORG_ID}`,
      { headers: AUTHED }
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /client-ai/admin/usage.csv', () => {
  it('streams text/csv with the pinned column order and audits the export', async () => {
    const res = await buildApp().request(
      '/client-ai/admin/usage.csv?from=2026-05&to=2026-06',
      { headers: AUTHED }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toContain('client-ai-usage-2026-05-to-2026-06.csv');
    const text = await res.text();
    const lines = text.split('\n');
    expect(lines[0]).toBe('month,org_name,user_email,messages,sessions,input_tokens,output_tokens,cost_cents');
    expect(lines[1]).toContain('"2026-05"');
    expect(lines[1]).toContain('"finance.user@contoso.com"');
    expect(lines).toHaveLength(3);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'client_ai.usage.export',
        details: expect.objectContaining({ rowCount: 2, from: '2026-05', to: '2026-06' }),
      })
    );
  });

  it('CSV cells are formula-neutralized (spreadsheetExport)', async () => {
    dbSelectMock.mockImplementation(() =>
      chain([{ ...USAGE_ROWS[0], userEmail: '=HYPERLINK("evil")' }])
    );
    const res = await buildApp().request(
      '/client-ai/admin/usage.csv?from=2026-05&to=2026-06',
      { headers: AUTHED }
    );
    const text = await res.text();
    expect(text).toContain(`"'=HYPERLINK(""evil"")"`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/adminUsage.test.ts`
Expected: FAIL with module-not-found for `./adminUsage`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/routes/clientAi/adminUsage.ts`:

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, gte, lte, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { clientAiUsage } from '../../db/schema/clientAi';
import { organizations } from '../../db/schema/orgs';
import { portalUsers } from '../../db/schema/portal';
import { requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { csvRow } from '../../services/spreadsheetExport';
import { resolveScopedOrgId } from '../c2c/helpers';
import { adminUsageQuerySchema } from './schemas';

/**
 * AI for Office — usage & billing report (spec §8, §9.4). Reads the
 * client_ai_usage monthly buckets (org × user × month) the Plan-2 session
 * loop writes; the CSV is the MSP's resale-invoicing artifact, so its column
 * order is a pinned contract. CSV building follows routes/tickets/export.ts
 * (csvRow — quoted + formula-neutralized cells); exports are audited like
 * routes/auditLogs.ts GET /export.
 */

export const clientAiAdminUsageRoutes = new Hono();

const requireOrgsRead = requirePermission(
  PERMISSIONS.ORGS_READ.resource,
  PERMISSIONS.ORGS_READ.action
);

const CSV_HEADERS = [
  'month',
  'org_name',
  'user_email',
  'messages',
  'sessions',
  'input_tokens',
  'output_tokens',
  'cost_cents',
];

type UsageQuery = { from: string; to: string; orgId?: string };

async function loadUsageRows(q: UsageQuery) {
  // period_key is 'YYYY-MM' for monthly rows — lexicographic range == calendar
  // range (same trick as the ai_cost_usage bucket pattern).
  const conditions: SQL[] = [
    eq(clientAiUsage.period, 'monthly'),
    gte(clientAiUsage.periodKey, q.from),
    lte(clientAiUsage.periodKey, q.to),
  ];
  if (q.orgId) conditions.push(eq(clientAiUsage.orgId, q.orgId));

  const rows = await db
    .select({
      periodKey: clientAiUsage.periodKey,
      orgId: clientAiUsage.orgId,
      orgName: organizations.name,
      clientUserId: clientAiUsage.clientUserId,
      userEmail: portalUsers.email,
      inputTokens: clientAiUsage.inputTokens,
      outputTokens: clientAiUsage.outputTokens,
      totalCostCents: clientAiUsage.totalCostCents,
      sessionCount: clientAiUsage.sessionCount,
      messageCount: clientAiUsage.messageCount,
    })
    .from(clientAiUsage)
    .leftJoin(organizations, eq(clientAiUsage.orgId, organizations.id))
    .leftJoin(portalUsers, eq(clientAiUsage.clientUserId, portalUsers.id))
    .where(and(...conditions))
    .orderBy(asc(clientAiUsage.periodKey), asc(organizations.name), asc(portalUsers.email));

  return rows.map((r) => ({
    month: r.periodKey,
    orgId: r.orgId,
    orgName: r.orgName ?? null,
    clientUserId: r.clientUserId,
    userEmail: r.userEmail ?? null,
    messageCount: Number(r.messageCount ?? 0),
    sessionCount: Number(r.sessionCount ?? 0),
    inputTokens: Number(r.inputTokens ?? 0),
    outputTokens: Number(r.outputTokens ?? 0),
    // totalCostCents is REAL (fractional cents accumulate) — round to 2dp.
    costCents: Math.round(Number(r.totalCostCents ?? 0) * 100) / 100,
  }));
}

function checkOrgAccess(
  c: { get: (k: 'auth') => Parameters<typeof resolveScopedOrgId>[0] },
  orgId: string | undefined
): boolean {
  if (!orgId) return true;
  return resolveScopedOrgId(c.get('auth'), orgId) !== null;
}

// ── GET /usage — JSON report ──────────────────────────────────────────────────
clientAiAdminUsageRoutes.get(
  '/usage',
  requireOrgsRead,
  zValidator('query', adminUsageQuerySchema),
  async (c) => {
    const q = c.req.valid('query');
    if (!checkOrgAccess(c as never, q.orgId)) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const rows = await loadUsageRows(q);
    const totals = rows.reduce(
      (acc, r) => ({
        messageCount: acc.messageCount + r.messageCount,
        sessionCount: acc.sessionCount + r.sessionCount,
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        costCents: Math.round((acc.costCents + r.costCents) * 100) / 100,
      }),
      { messageCount: 0, sessionCount: 0, inputTokens: 0, outputTokens: 0, costCents: 0 }
    );

    return c.json({ rows, totals });
  }
);

// ── GET /usage.csv — the invoicing artifact ──────────────────────────────────
clientAiAdminUsageRoutes.get(
  '/usage.csv',
  requireOrgsRead,
  zValidator('query', adminUsageQuerySchema),
  async (c) => {
    const q = c.req.valid('query');
    if (!checkOrgAccess(c as never, q.orgId)) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const rows = await loadUsageRows(q);

    writeRouteAudit(c, {
      orgId: q.orgId ?? null,
      action: 'client_ai.usage.export',
      resourceType: 'client_ai_usage',
      details: { from: q.from, to: q.to, orgId: q.orgId ?? null, rowCount: rows.length },
    });

    const lines = [CSV_HEADERS.join(',')];
    for (const r of rows) {
      lines.push(
        csvRow([
          r.month,
          r.orgName ?? '',
          r.userEmail ?? '',
          r.messageCount,
          r.sessionCount,
          r.inputTokens,
          r.outputTokens,
          r.costCents,
        ])
      );
    }

    c.header('Content-Type', 'text/csv');
    c.header(
      'Content-Disposition',
      `attachment; filename="client-ai-usage-${q.from}-to-${q.to}.csv"`
    );
    return c.body(lines.join('\n'));
  }
);
```

- [ ] **Step 4: Mount in `admin.ts`**

```ts
import { clientAiAdminUsageRoutes } from './adminUsage';
// ...
clientAiAdminRoutes.route('/', clientAiAdminUsageRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/adminUsage.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/clientAi/adminUsage.ts apps/api/src/routes/clientAi/adminUsage.test.ts apps/api/src/routes/clientAi/admin.ts
git commit -m "feat(client-ai): usage report endpoint + audited CSV export" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Admin template CRUD (TDD)

Spec §9.5/§10. Org-scoped rows (`org_id` set) and partner-wide rows (`org_id NULL`, `partner_id` set) on `client_ai_prompt_templates` (Plan 1 migration §5, dual-axis RLS). Partner-wide writes require partner/system scope with a `partnerId` — org-scope callers get a clean 403 instead of the RLS 42501 that bit `custom_field_definitions` (memory: `rls_dual_axis_contract_test_blindspot`).

**Files:**
- Create: apps/api/src/routes/clientAi/adminTemplates.ts
- Test: apps/api/src/routes/clientAi/adminTemplates.test.ts
- Modify: apps/api/src/routes/clientAi/admin.ts (mount)

- [ ] **Step 1: Write the failing test**

`apps/api/src/routes/clientAi/adminTemplates.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { dbSelectMock, dbInsertMock, dbUpdateMock, dbDeleteMock, writeRouteAuditMock, authState } =
  vi.hoisted(() => ({
    dbSelectMock: vi.fn(),
    dbInsertMock: vi.fn(),
    dbUpdateMock: vi.fn(),
    dbDeleteMock: vi.fn(),
    writeRouteAuditMock: vi.fn(),
    authState: {
      scope: 'partner' as string,
      partnerId: 'f0f0f0f0-1111-4222-8333-444455556666' as string | null,
    },
  }));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      scope: authState.scope,
      partnerId: authState.partnerId,
      orgId: authState.scope === 'organization' ? '0c0c0c0c-1111-4222-8333-444455556666' : null,
      accessibleOrgIds: ['0c0c0c0c-1111-4222-8333-444455556666'],
      user: { id: 'ce11ce11-1111-4222-8333-444455556666', email: 'msp@example.com' },
    });
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

vi.mock('../../config/env', () => ({
  CLIENT_AI_ENTRA_CLIENT_ID: '00000000-aaaa-bbbb-cccc-000000000001',
}));

vi.mock('../../db', () => ({
  db: { select: dbSelectMock, insert: dbInsertMock, update: dbUpdateMock, delete: dbDeleteMock },
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

import { clientAiAdminTemplateRoutes } from './adminTemplates';
import { authMiddleware } from '../../middleware/auth';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const OTHER_ORG_ID = '9d9d9d9d-1111-4222-8333-444455556666';
const PARTNER_ID = 'f0f0f0f0-1111-4222-8333-444455556666';
const TEMPLATE_ID = '7e7e7e7e-1111-4222-8333-444455556666';

const PARTNER_ROW = {
  id: TEMPLATE_ID,
  orgId: null,
  partnerId: PARTNER_ID,
  orgName: null,
  name: 'Quarterly variance walkthrough',
  description: null,
  promptBody: 'Explain the variance between the selected columns.',
  category: 'finance',
  createdAt: new Date(),
  updatedAt: new Date(),
};

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const self = vi.fn(() => c);
  for (const m of ['from', 'where', 'orderBy', 'groupBy', 'leftJoin', 'limit', 'offset']) {
    c[m] = self;
  }
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return c;
}

function buildApp() {
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/client-ai/admin', clientAiAdminTemplateRoutes);
  return app;
}

const AUTHED = { Authorization: 'Bearer token', 'Content-Type': 'application/json' };

beforeEach(() => {
  vi.clearAllMocks();
  authState.scope = 'partner';
  authState.partnerId = PARTNER_ID;
  dbSelectMock.mockImplementation(() => chain([PARTNER_ROW]));
  dbInsertMock.mockImplementation(() => ({
    values: vi.fn((v: Record<string, unknown>) => ({
      returning: vi.fn(() => Promise.resolve([{ ...PARTNER_ROW, ...v }])),
    })),
  }));
  dbUpdateMock.mockImplementation(() => ({
    set: vi.fn((v: Record<string, unknown>) => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ ...PARTNER_ROW, ...v }])),
      })),
    })),
  }));
  dbDeleteMock.mockImplementation(() => ({
    where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([PARTNER_ROW])) })),
  }));
});

describe('GET /client-ai/admin/templates', () => {
  it('lists all RLS-visible templates with orgName', async () => {
    const res = await buildApp().request('/client-ai/admin/templates', { headers: AUTHED });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0]).toMatchObject({ id: TEMPLATE_ID, partnerId: PARTNER_ID, orgId: null });
  });

  it('404s an orgId filter outside the caller scope', async () => {
    const res = await buildApp().request(
      `/client-ai/admin/templates?orgId=${OTHER_ORG_ID}`,
      { headers: AUTHED }
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /client-ai/admin/templates', () => {
  it('creates a partner-wide row when orgId is null and audits', async () => {
    const res = await buildApp().request('/client-ai/admin/templates', {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ name: 'New', promptBody: 'Body', orgId: null }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.template).toMatchObject({ orgId: null, partnerId: PARTNER_ID });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'client_ai.template.create',
        resourceType: 'client_ai_prompt_template',
        details: expect.objectContaining({ scope: 'partner' }),
      })
    );
  });

  it('creates an org-scoped row when orgId is provided', async () => {
    const res = await buildApp().request('/client-ai/admin/templates', {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ name: 'Org one', promptBody: 'Body', orgId: ORG_ID }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).template).toMatchObject({ orgId: ORG_ID, partnerId: null });
  });

  it('404s an org-scoped create for an inaccessible org', async () => {
    const res = await buildApp().request('/client-ai/admin/templates', {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ name: 'X', promptBody: 'Y', orgId: OTHER_ORG_ID }),
    });
    expect(res.status).toBe(404);
  });

  it('403s a partner-wide create from organization scope (clean error, not RLS 42501)', async () => {
    authState.scope = 'organization';
    authState.partnerId = null;
    const res = await buildApp().request('/client-ai/admin/templates', {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ name: 'X', promptBody: 'Y', orgId: null }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'partner_scope_required' });
  });

  it('400s a strict-schema violation', async () => {
    const res = await buildApp().request('/client-ai/admin/templates', {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ name: 'X', promptBody: 'Y', surprise: 1 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PUT /client-ai/admin/templates/:id', () => {
  it('updates fields on an existing row and audits', async () => {
    const res = await buildApp().request(`/client-ai/admin/templates/${TEMPLATE_ID}`, {
      method: 'PUT',
      headers: AUTHED,
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).template.name).toBe('Renamed');
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'client_ai.template.update', resourceId: TEMPLATE_ID })
    );
  });

  it('404s a missing row', async () => {
    dbSelectMock.mockImplementation(() => chain([]));
    const res = await buildApp().request(`/client-ai/admin/templates/${TEMPLATE_ID}`, {
      method: 'PUT',
      headers: AUTHED,
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /client-ai/admin/templates/:id', () => {
  it('deletes and audits', async () => {
    const res = await buildApp().request(`/client-ai/admin/templates/${TEMPLATE_ID}`, {
      method: 'DELETE',
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'client_ai.template.delete', resourceId: TEMPLATE_ID })
    );
  });

  it('404s when nothing was deleted', async () => {
    dbDeleteMock.mockImplementation(() => ({
      where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) })),
    }));
    const res = await buildApp().request(`/client-ai/admin/templates/${TEMPLATE_ID}`, {
      method: 'DELETE',
      headers: AUTHED,
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/adminTemplates.test.ts`
Expected: FAIL with module-not-found for `./adminTemplates`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/routes/clientAi/adminTemplates.ts`:

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { clientAiPromptTemplates } from '../../db/schema/clientAi';
import { organizations } from '../../db/schema/orgs';
import { requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { resolveScopedOrgId } from '../c2c/helpers';
import { templateBodySchema, templateUpdateSchema, templateListQuerySchema } from './schemas';

/**
 * AI for Office — prompt-template manager (spec §9.5, §10).
 *
 * client_ai_prompt_templates is dual-axis: org rows (org_id set, partner_id
 * NULL) and partner-wide rows (org_id NULL, partner_id set). Partner-wide
 * writes REQUIRE a partner/system caller carrying partnerId; org-scope
 * callers get a clean 403 partner_scope_required instead of bubbling the RLS
 * 42501 — the exact custom_field_definitions failure mode (2026-06-11-i).
 * The end-to-end breeze_app proof for the partner-axis write path lives in
 * __tests__/integration/client-ai-template-routes.integration.test.ts (Task 7).
 *
 * Scope is immutable after create (templateUpdateSchema has no orgId) — move
 * a template by delete + recreate. Keeps the dual-axis invariants trivial.
 */

export const clientAiAdminTemplateRoutes = new Hono();

const requireOrgsRead = requirePermission(
  PERMISSIONS.ORGS_READ.resource,
  PERMISSIONS.ORGS_READ.action
);
const requireOrgsWrite = requirePermission(
  PERMISSIONS.ORGS_WRITE.resource,
  PERMISSIONS.ORGS_WRITE.action
);

type TemplateAuth = {
  scope: 'system' | 'partner' | 'organization';
  partnerId: string | null;
  user?: { id: string };
};

const templateSelection = {
  id: clientAiPromptTemplates.id,
  orgId: clientAiPromptTemplates.orgId,
  partnerId: clientAiPromptTemplates.partnerId,
  orgName: organizations.name,
  name: clientAiPromptTemplates.name,
  description: clientAiPromptTemplates.description,
  promptBody: clientAiPromptTemplates.promptBody,
  category: clientAiPromptTemplates.category,
  createdAt: clientAiPromptTemplates.createdAt,
  updatedAt: clientAiPromptTemplates.updatedAt,
};

// ── GET /templates ────────────────────────────────────────────────────────────
clientAiAdminTemplateRoutes.get(
  '/templates',
  requireOrgsRead,
  zValidator('query', templateListQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const q = c.req.valid('query');

    if (q.orgId && !resolveScopedOrgId(auth, q.orgId)) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    // RLS bounds visibility (own partner rows + accessible-org rows); the
    // optional filters narrow within that.
    let rows = await db
      .select(templateSelection)
      .from(clientAiPromptTemplates)
      .leftJoin(organizations, eq(clientAiPromptTemplates.orgId, organizations.id))
      .orderBy(asc(clientAiPromptTemplates.name));

    if (q.orgId) rows = rows.filter((r) => r.orgId === q.orgId);
    if (q.scope === 'partner') rows = rows.filter((r) => r.orgId === null);
    if (q.scope === 'org') rows = rows.filter((r) => r.orgId !== null);

    return c.json({ data: rows });
  }
);

// ── POST /templates ───────────────────────────────────────────────────────────
clientAiAdminTemplateRoutes.post(
  '/templates',
  requireOrgsWrite,
  zValidator('json', templateBodySchema),
  async (c) => {
    const auth = c.get('auth') as TemplateAuth & Parameters<typeof resolveScopedOrgId>[0];
    const body = c.req.valid('json');
    const targetOrgId = body.orgId ?? null;

    let values: typeof clientAiPromptTemplates.$inferInsert;
    if (targetOrgId) {
      const orgId = resolveScopedOrgId(auth, targetOrgId);
      if (!orgId) return c.json({ error: 'Organization not found' }, 404);
      values = {
        orgId,
        partnerId: null,
        name: body.name,
        description: body.description ?? null,
        promptBody: body.promptBody,
        category: body.category ?? null,
        createdBy: auth.user?.id ?? null,
      };
    } else {
      // Partner-wide row: org_id NULL + partner_id set. Gate BEFORE the
      // insert so org-scope callers see 403, not an RLS 42501 surprise.
      if (auth.scope === 'organization' || !auth.partnerId) {
        return c.json({ error: 'partner_scope_required' }, 403);
      }
      values = {
        orgId: null,
        partnerId: auth.partnerId,
        name: body.name,
        description: body.description ?? null,
        promptBody: body.promptBody,
        category: body.category ?? null,
        createdBy: auth.user?.id ?? null,
      };
    }

    const [row] = await db.insert(clientAiPromptTemplates).values(values).returning();
    if (!row) return c.json({ error: 'Failed to create template' }, 500);

    writeRouteAudit(c, {
      orgId: row.orgId ?? null,
      action: 'client_ai.template.create',
      resourceType: 'client_ai_prompt_template',
      resourceId: row.id,
      resourceName: row.name,
      details: { scope: row.orgId ? 'org' : 'partner' },
    });

    return c.json({ template: row }, 201);
  }
);

// ── PUT /templates/:id ────────────────────────────────────────────────────────
clientAiAdminTemplateRoutes.put(
  '/templates/:id',
  requireOrgsWrite,
  zValidator('json', templateUpdateSchema),
  async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');

    // RLS scopes the read: a row outside the caller's tenancy is a plain 404.
    const [existing] = await db
      .select(templateSelection)
      .from(clientAiPromptTemplates)
      .leftJoin(organizations, eq(clientAiPromptTemplates.orgId, organizations.id))
      .where(eq(clientAiPromptTemplates.id, id))
      .limit(1);
    if (!existing) return c.json({ error: 'Template not found' }, 404);

    const set: Partial<typeof clientAiPromptTemplates.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) set.name = body.name;
    if (body.description !== undefined) set.description = body.description ?? null;
    if (body.promptBody !== undefined) set.promptBody = body.promptBody;
    if (body.category !== undefined) set.category = body.category ?? null;

    const [row] = await db
      .update(clientAiPromptTemplates)
      .set(set)
      .where(eq(clientAiPromptTemplates.id, id))
      .returning();
    if (!row) return c.json({ error: 'Template not found' }, 404);

    writeRouteAudit(c, {
      orgId: row.orgId ?? null,
      action: 'client_ai.template.update',
      resourceType: 'client_ai_prompt_template',
      resourceId: id,
      resourceName: row.name,
      details: { changedKeys: Object.keys(set).filter((k) => k !== 'updatedAt') },
    });

    return c.json({ template: row });
  }
);

// ── DELETE /templates/:id ─────────────────────────────────────────────────────
clientAiAdminTemplateRoutes.delete('/templates/:id', requireOrgsWrite, async (c) => {
  const id = c.req.param('id');

  const [row] = await db
    .delete(clientAiPromptTemplates)
    .where(eq(clientAiPromptTemplates.id, id))
    .returning();
  if (!row) return c.json({ error: 'Template not found' }, 404);

  writeRouteAudit(c, {
    orgId: row.orgId ?? null,
    action: 'client_ai.template.delete',
    resourceType: 'client_ai_prompt_template',
    resourceId: id,
    resourceName: row.name,
  });

  return c.json({ success: true });
});
```

(Implementation note: the list route filters `orgId`/`scope` in JS after the RLS-bounded select instead of composing `where` — the visible set is small (templates, not telemetry) and it keeps the Drizzle mock trivial. If template counts ever matter, push the filters into SQL.)

- [ ] **Step 4: Mount in `admin.ts`**

```ts
import { clientAiAdminTemplateRoutes } from './adminTemplates';
// ...
clientAiAdminRoutes.route('/', clientAiAdminTemplateRoutes);
```

After this task, the full mount block at the end of `apps/api/src/routes/clientAi/admin.ts` reads:

```ts
// ── Plan-4 dashboard sub-routers (inherit group auth + dark-gate above) ──────
clientAiAdminRoutes.route('/', clientAiAdminOrgRoutes);
clientAiAdminRoutes.route('/', clientAiAdminSessionRoutes);
clientAiAdminRoutes.route('/', clientAiAdminUsageRoutes);
clientAiAdminRoutes.route('/', clientAiAdminTemplateRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/adminTemplates.test.ts`
Expected: 12 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/clientAi/adminTemplates.ts apps/api/src/routes/clientAi/adminTemplates.test.ts apps/api/src/routes/clientAi/admin.ts
git commit -m "feat(client-ai): admin template CRUD with org + partner-wide scopes" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Client-facing GET /client-ai/templates (TDD)

The add-in's template picker source (spec §10, §11 — Plan 5 consumes this). Auth via Plan 1's `clientAiAuthMiddleware` + `requireClientAiEnabledMiddleware` (`apps/api/src/middleware/clientAiAuth.ts`). **Read decision 4 before touching this:** the middleware's DB context has `accessiblePartnerIds: []`, so the partner-wide rows require a narrowly re-scoped read.

**Files:**
- Create: apps/api/src/routes/clientAi/templates.ts
- Test: apps/api/src/routes/clientAi/templates.test.ts
- Modify: apps/api/src/routes/clientAi/index.ts (mount)

- [ ] **Step 1: Write the failing test**

`apps/api/src/routes/clientAi/templates.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { dbSelectMock, withDbAccessContextMock, runOutsideDbContextMock, capturedContexts } =
  vi.hoisted(() => {
    const captured: unknown[] = [];
    return {
      dbSelectMock: vi.fn(),
      withDbAccessContextMock: vi.fn((ctx: unknown, fn: () => unknown) => {
        captured.push(ctx);
        return fn();
      }),
      runOutsideDbContextMock: vi.fn((fn: () => unknown) => fn()),
      capturedContexts: captured,
    };
  });

vi.mock('../../db', () => ({
  db: { select: dbSelectMock },
  withDbAccessContext: withDbAccessContextMock,
  runOutsideDbContext: runOutsideDbContextMock,
}));

vi.mock('../../middleware/clientAiAuth', () => ({
  clientAiAuthMiddleware: vi.fn((c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'unauthorized' }, 401);
    c.set('clientAiAuth', {
      clientUserId: 'beefbeef-1111-4222-8333-444455556666',
      orgId: '0c0c0c0c-1111-4222-8333-444455556666',
      email: 'finance.user@contoso.com',
      name: 'Finance User',
      token: 'tok',
    });
    return next();
  }),
  requireClientAiEnabledMiddleware: vi.fn((_c: any, next: any) => next()),
}));

import { clientAiTemplateRoutes } from './templates';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const PARTNER_ID = 'f0f0f0f0-1111-4222-8333-444455556666';

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const self = vi.fn(() => c);
  for (const m of ['from', 'where', 'orderBy', 'groupBy', 'leftJoin', 'limit', 'offset']) {
    c[m] = self;
  }
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return c;
}

function buildApp() {
  const app = new Hono();
  app.route('/client-ai', clientAiTemplateRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedContexts.length = 0;
  let call = 0;
  dbSelectMock.mockImplementation(() => {
    call++;
    if (call === 1) return chain([{ partnerId: PARTNER_ID }]); // org row lookup
    return chain([
      {
        id: 't-org',
        name: 'Org template',
        description: null,
        category: 'finance',
        promptBody: 'Org body',
      },
      {
        id: 't-partner',
        name: 'Partner template',
        description: 'For all orgs',
        category: null,
        promptBody: 'Partner body',
      },
    ]);
  });
});

describe('GET /client-ai/templates', () => {
  it('401s without a session', async () => {
    const res = await buildApp().request('/client-ai/templates');
    expect(res.status).toBe(401);
  });

  it('returns the pinned bare-array shape with promptBody mapped to body', async () => {
    const res = await buildApp().request('/client-ai/templates', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[1]).toEqual({
      id: 't-partner',
      name: 'Partner template',
      description: 'For all orgs',
      category: null,
      body: 'Partner body',
    });
    expect(body[0]).not.toHaveProperty('promptBody');
  });

  it('re-scopes the template read with the org partner axis (decision 4)', async () => {
    await buildApp().request('/client-ai/templates', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]).toEqual({
      scope: 'organization',
      orgId: ORG_ID,
      accessibleOrgIds: [ORG_ID],
      accessiblePartnerIds: [PARTNER_ID],
      userId: null,
    });
  });

  it('still serves org-scoped templates when the org row has no partner (defensive)', async () => {
    let call = 0;
    dbSelectMock.mockImplementation(() => {
      call++;
      if (call === 1) return chain([]); // org row not visible — should not happen, fail safe
      return chain([
        { id: 't-org', name: 'Org template', description: null, category: null, promptBody: 'X' },
      ]);
    });
    const res = await buildApp().request('/client-ai/templates', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(200);
    expect((await res.json())[0].id).toBe('t-org');
    expect((capturedContexts[0] as { accessiblePartnerIds: string[] }).accessiblePartnerIds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/templates.test.ts`
Expected: FAIL with module-not-found for `./templates`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/routes/clientAi/templates.ts`:

```ts
import { Hono } from 'hono';
import { asc, eq, or } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext } from '../../db';
import { clientAiPromptTemplates } from '../../db/schema/clientAi';
import { organizations } from '../../db/schema/orgs';
import {
  clientAiAuthMiddleware,
  requireClientAiEnabledMiddleware,
} from '../../middleware/clientAiAuth';

/**
 * AI for Office — client-facing template list (spec §10/§11). Consumed by the
 * Plan-5 add-in's empty-chat template picker. Response shape is PINNED:
 * a bare JSON array of { id, name, description, category, body }.
 *
 * RLS subtlety (Plan-4 decision 4): clientAiAuthMiddleware opens an
 * org-scoped DB context with accessiblePartnerIds: [], under which
 * partner-wide template rows (org_id NULL, dual-axis policy) are INVISIBLE —
 * breeze_has_partner_access([]) is always false. And withDbAccessContext is a
 * no-op when a context is already open (db/index.ts:103-105). So:
 *   1. Read the org's partner_id INSIDE the middleware context (the org's own
 *      row is readable: organizations is id-keyed shape 2).
 *   2. runOutsideDbContext + a fresh context that adds ONLY the org's own
 *      partner to the partner axis, for the single template SELECT, with an
 *      explicit WHERE (org row OR own-partner row) layered on top of RLS.
 * This grants the client principal the partner axis for exactly one read-only
 * statement — it does NOT broaden the middleware context. The inner context
 * briefly uses a second pooled connection while the outer request transaction
 * is open; both are short reads (#1105 concerns long holds, not this).
 */

export const clientAiTemplateRoutes = new Hono();

clientAiTemplateRoutes.get(
  '/templates',
  clientAiAuthMiddleware,
  requireClientAiEnabledMiddleware,
  async (c) => {
    const auth = c.get('clientAiAuth');

    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, auth.orgId))
      .limit(1);
    const partnerId = org?.partnerId ?? null;

    const orgCondition = eq(clientAiPromptTemplates.orgId, auth.orgId);
    const where = partnerId
      ? or(orgCondition, eq(clientAiPromptTemplates.partnerId, partnerId))
      : orgCondition;

    const rows = await runOutsideDbContext(() =>
      withDbAccessContext(
        {
          scope: 'organization',
          orgId: auth.orgId,
          accessibleOrgIds: [auth.orgId],
          accessiblePartnerIds: partnerId ? [partnerId] : [],
          userId: null,
        },
        () =>
          db
            .select({
              id: clientAiPromptTemplates.id,
              name: clientAiPromptTemplates.name,
              description: clientAiPromptTemplates.description,
              category: clientAiPromptTemplates.category,
              promptBody: clientAiPromptTemplates.promptBody,
            })
            .from(clientAiPromptTemplates)
            .where(where)
            .orderBy(asc(clientAiPromptTemplates.name))
      )
    );

    return c.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        category: r.category,
        body: r.promptBody,
      }))
    );
  }
);
```

- [ ] **Step 4: Mount in `index.ts`**

`apps/api/src/routes/clientAi/index.ts` gains:

```ts
import { clientAiTemplateRoutes } from './templates';

// Client-facing (add-in) routes — clientAiAuthMiddleware inside.
clientAiRoutes.route('/', clientAiTemplateRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/templates.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/clientAi/templates.ts apps/api/src/routes/clientAi/templates.test.ts apps/api/src/routes/clientAi/index.ts
git commit -m "feat(client-ai): client-facing template list with re-scoped partner-axis read" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Route-level dual-axis RLS integration test (real DB)

Spec §10 warning + pinned contract: prove the **route's** partner-wide insert works as `breeze_app`. Plan 1 Task 5 proved the raw SQL path (`client-ai-templates-rls.integration.test.ts`); this proves the full route → Drizzle → RLS path, which is exactly where `custom_field_definitions` regressed (route wrote partner-wide rows the policies couldn't accept → 42501/500; memory note `rls_dual_axis_contract_test_blindspot`). The real `authMiddleware` needs JWTs/users, so the middleware module is mocked to set the auth context AND open the same partner-scope `withDbAccessContext` the real one does (`middleware/auth.ts:440-447`) — the route, Drizzle layer, RLS GUCs, and policies are all real.

**Files:**
- Create: apps/api/src/__tests__/integration/client-ai-template-routes.integration.test.ts

- [ ] **Step 1: Write the test**

```ts
/**
 * client_ai_prompt_templates ROUTE-level dual-axis proof (spec §10 warning).
 *
 * Drives the real adminTemplates routes against the real docker postgres as
 * breeze_app: a partner-wide POST (org_id NULL) must succeed under the
 * dual-axis policies of 2026-06-12-b-client-ai-foundation.sql, and the
 * created row must be invisible to a different partner. The rls-coverage
 * contract test provably cannot catch a missing partner axis; only this
 * functional path can (custom_field_definitions lesson, 2026-06-11-i).
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

let activeAuthContext: {
  scope: 'partner';
  partnerId: string;
  accessibleOrgIds: string[];
} | null = null;

vi.mock('../../middleware/auth', async () => {
  const { withDbAccessContext } = await import('../../db');
  return {
    authMiddleware: (c: any, next: any) => {
      if (!activeAuthContext) return c.json({ error: 'Unauthorized' }, 401);
      c.set('auth', {
        scope: activeAuthContext.scope,
        partnerId: activeAuthContext.partnerId,
        orgId: null,
        accessibleOrgIds: activeAuthContext.accessibleOrgIds,
        user: { id: null, email: 'integration@test' },
      });
      // Same context shape the real authMiddleware opens (middleware/auth.ts:440-447).
      return withDbAccessContext(
        {
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: activeAuthContext.accessibleOrgIds,
          accessiblePartnerIds: [activeAuthContext.partnerId],
          userId: null,
        },
        () => next()
      );
    },
    requirePermission: () => (_c: any, next: any) => next(),
    requireMfa: () => (_c: any, next: any) => next(),
  };
});

vi.mock('../../config/env', () => ({
  CLIENT_AI_ENTRA_CLIENT_ID: '00000000-aaaa-bbbb-cccc-000000000001',
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

import { db, withDbAccessContext } from '../../db';
import { clientAiPromptTemplates } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const created: string[] = [];

afterEach(async () => {
  if (created.length === 0) return;
  await withDbAccessContext(
    { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null },
    async () => {
      for (const id of created) {
        await db.delete(clientAiPromptTemplates).where(eq(clientAiPromptTemplates.id, id));
      }
    }
  );
  created.length = 0;
});

beforeEach(() => {
  activeAuthContext = null;
});

async function buildApp() {
  // Import AFTER mocks are registered.
  const { clientAiAdminTemplateRoutes } = await import('../../routes/clientAi/adminTemplates');
  const { authMiddleware } = await import('../../middleware/auth');
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/client-ai/admin', clientAiAdminTemplateRoutes);
  return app;
}

const JSON_HEADERS = { Authorization: 'Bearer x', 'Content-Type': 'application/json' };

describe('adminTemplates routes against real RLS (breeze_app)', () => {
  it('POST creates a partner-wide template (org_id NULL) — the §10 write path', async () => {
    const partner = await createPartner();
    activeAuthContext = { scope: 'partner', partnerId: partner.id, accessibleOrgIds: [] };

    const app = await buildApp();
    const res = await app.request('/client-ai/admin/templates', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: 'Partner-wide variance template',
        promptBody: 'Explain the variance in the selection.',
        orgId: null,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.template.orgId).toBeNull();
    expect(body.template.partnerId).toBe(partner.id);
    created.push(body.template.id);

    // And the list sees it back through the same partner scope.
    const list = await app.request('/client-ai/admin/templates', { headers: JSON_HEADERS });
    const listBody = await list.json();
    expect(listBody.data.map((t: { id: string }) => t.id)).toContain(body.template.id);
  });

  it('a different partner cannot see the row (RLS, not app filtering)', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();

    activeAuthContext = { scope: 'partner', partnerId: partnerA.id, accessibleOrgIds: [] };
    let app = await buildApp();
    const createRes = await app.request('/client-ai/admin/templates', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'A-only', promptBody: 'x', orgId: null }),
    });
    const { template } = await createRes.json();
    created.push(template.id);

    activeAuthContext = { scope: 'partner', partnerId: partnerB.id, accessibleOrgIds: [] };
    app = await buildApp();
    const list = await app.request('/client-ai/admin/templates', { headers: JSON_HEADERS });
    const listBody = await list.json();
    expect(listBody.data.map((t: { id: string }) => t.id)).not.toContain(template.id);

    const update = await app.request(`/client-ai/admin/templates/${template.id}`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'hijacked' }),
    });
    expect(update.status).toBe(404); // RLS-invisible == not found
  });

  it('POST creates an org-scoped template under the org axis', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeAuthContext = { scope: 'partner', partnerId: partner.id, accessibleOrgIds: [org.id] };

    const app = await buildApp();
    const res = await app.request('/client-ai/admin/templates', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Org template', promptBody: 'y', orgId: org.id }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.template.orgId).toBe(org.id);
    expect(body.template.partnerId).toBeNull();
    created.push(body.template.id);
  });
});
```

- [ ] **Step 2: Run against the docker test stack**

```bash
cd /Users/toddhebebrand/breeze/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm test:docker:up
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/client-ai-template-routes.integration.test.ts
```

Expected: 3 tests PASS. If the partner-wide POST returns 500 with a 42501 cause, the dual-axis policies are broken — stop and fix the Plan-1 migration situation before shipping anything.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/client-ai-template-routes.integration.test.ts
git commit -m "test(client-ai): route-level partner-wide template insert proof as breeze_app" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Web dashboard tasks (Tasks 8–14)

Conventions for every web task below — all verified against the real codebase, cite-checked file:line:

- **Fetch:** `fetchWithAuth` from `../../stores/auth` (`apps/web/src/stores/auth.ts:406`). It Bearer-authenticates, retries once on 401 via refresh cookie, and **auto-injects `?orgId=`** from the org store (deviation 10) — the Plan-4 admin endpoints tolerate that as a filter.
- **Mutations:** every POST/PUT/DELETE goes through `runAction` (`apps/web/src/lib/runAction.ts`), `onUnauthorized: () => void navigateTo('/login', { replace: true })` (the `OrgPortalSettingsEditor.tsx:68-88` idiom). Catch with the exported standard handler `handleActionError(err, fallback)` (`runAction.ts:87-90`) — it implements the CLAUDE.md pattern verbatim (401 ActionError → return, non-ActionError → fallback toast, other ActionErrors already toasted).
- **GET loads:** plain `fetchWithAuth` + `res.ok` checks with a load-error card + Retry (the `AiUsagePage.tsx`/`BillablesExportCard.tsx` idiom) — `runAction` is for mutations.
- **Dialogs:** `Dialog` / `ConfirmDialog` from `../shared/Dialog` / `../shared/ConfirmDialog` (no Drawer component exists in this codebase — the wizard and transcript viewer are Dialogs).
- **Tables/badges:** thead `bg-muted/40` + uppercase tracking-wide header row, `rounded-full` chip badges — copied from `AiUsagePage.tsx:368-421` and `HuntressIntegration.tsx:75-85`.
- **Toasts:** `showToast` from `../shared/Toast` (`{ message, type: 'success' | 'error' | 'warning' | 'undo' }`).
- **Hash state:** `window.location.hash` only (never query params) — `DeviceDetails.tsx:147-166` for plain tabs, `OrganizationsPage.tsx:46/187` for ids in the hash. This plan's scheme: `#orgs` (default) / `#sessions` / `#usage` / `#templates` / `#policy/<orgId>`.
- **data-testid on every interactive/asserted element** (`ai-office-*` prefix) — e2e suites are testid-only per `e2e-tests/README.md`.
- **Tests:** Vitest + jsdom + `@testing-library/react`, colocated `*.test.tsx`, `vi.mock('../../stores/auth')` + `vi.mock('../shared/Toast')` + `vi.mock('@/lib/navigation')`, `makeJsonResponse` helper — copied from `OrgPortalSettingsEditor.test.tsx`. Per deviation 8, components are **implement-then-test** in the same task (API tasks above were strict TDD; this is the explored web norm).
- **WS-A guard:** each component with mutating calls is added to `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts:30-53` in the task that creates it. UsageTab is GET-only (CSV export) and is not adopted.
- Every pnpm/vitest command carries the Node pin prefix.

---

### Task 8: OrgsTab — org status table + onboarding wizard

Spec §9.1. Consumes Task 2's `GET /client-ai/admin/orgs` + `GET /orgs/:orgId/consent-url`, and Plan 1's `PUT/DELETE /orgs/:orgId/tenant-mapping` + `PUT /orgs/:orgId/policy`. The wizard is a 4-step Dialog: tenant mapping (pre-filled from `suggestedEntraTenantId` — the M365-connection reuse audit, Task 2) → admin-consent URL with copy button → enable toggle → static centralized-deployment instructions.

**Files:**
- Create: apps/web/src/components/clientAi/OrgsTab.tsx
- Create: apps/web/src/components/clientAi/OrgsTab.test.tsx
- Modify: apps/web/src/lib/__tests__/no-silent-mutations.test.ts (`TARGET_GLOBS`)

- [ ] **Step 1: Write the component**

`apps/web/src/components/clientAi/OrgsTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  ClipboardCopy,
  Clock,
  ExternalLink,
  Loader2,
  Settings2,
  SlidersHorizontal,
  Unplug,
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { Dialog } from '../shared/Dialog';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { runAction, handleActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';

/**
 * AI for Office — per-org provisioning status + onboarding wizard (spec §9.1).
 * Reads GET /client-ai/admin/orgs (Plan-4 Task 2); the wizard writes Plan 1's
 * tenant-mapping and policy endpoints. Status chip is driven by consentStatus
 * exactly as Task 2 derives it: unknown → Not provisioned, pending → Consent
 * pending, granted → Active. policyEnabled is a separate column — consent and
 * the enable flip are independent facts.
 */

/** Row shape of GET /client-ai/admin/orgs (Plan-4 Task 2). */
export interface OrgStatusRow {
  orgId: string;
  orgName: string;
  mapped: boolean;
  entraTenantId: string | null;
  suggestedEntraTenantId: string | null;
  consentStatus: 'unknown' | 'pending' | 'granted';
  policyEnabled: boolean;
  currentMonthCostCents: number;
  currentMonthMessages: number;
}

interface OrgsTabProps {
  /** Jump to the per-org policy editor (#policy/<orgId>, wired by AiForOfficePage). */
  onOpenPolicy: (orgId: string) => void;
}

// Mirrors ENTRA_TENANT_GUID_REGEX (apps/api routes/clientAi/schemas.ts) — UX
// pre-validation only; the server re-validates.
const ENTRA_TENANT_GUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const formatCost = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Spec §9.1 status chip: not provisioned / consent pending / active. */
function StatusChip({ status }: { status: OrgStatusRow['consentStatus'] }) {
  if (status === 'granted') {
    return (
      <span
        data-testid="ai-office-status-active"
        className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400"
      >
        <CheckCircle2 className="h-3 w-3" /> Active
      </span>
    );
  }
  if (status === 'pending') {
    return (
      <span
        data-testid="ai-office-status-pending"
        className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400"
      >
        <Clock className="h-3 w-3" /> Consent pending
      </span>
    );
  }
  return (
    <span
      data-testid="ai-office-status-unprovisioned"
      className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600 dark:border-slate-500/30 dark:bg-slate-500/10 dark:text-slate-400"
    >
      <Unplug className="h-3 w-3" /> Not provisioned
    </span>
  );
}

export default function OrgsTab({ onOpenPolicy }: OrgsTabProps) {
  const [rows, setRows] = useState<OrgStatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [notEnabled, setNotEnabled] = useState(false);
  const [wizardOrgId, setWizardOrgId] = useState<string | null>(null);
  const [unmapOrg, setUnmapOrg] = useState<OrgStatusRow | null>(null);
  const [unmapping, setUnmapping] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoadError(false);
      const res = await fetchWithAuth('/client-ai/admin/orgs');
      if (res.status === 404) {
        // CLIENT_AI_ENTRA_CLIENT_ID dark-gate (Plan 1): the whole
        // /client-ai/admin group 404s until the add-in app registration is
        // configured on the API.
        setNotEnabled(true);
        return;
      }
      if (res.status === 401) {
        void navigateTo('/login', { replace: true });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data: OrgStatusRow[] };
      setRows(body.data ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmUnmap = async () => {
    if (!unmapOrg || unmapping) return;
    setUnmapping(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/client-ai/admin/orgs/${unmapOrg.orgId}/tenant-mapping`, {
            method: 'DELETE',
          }),
        errorFallback: 'Failed to remove tenant mapping',
        successMessage: `Tenant mapping removed for ${unmapOrg.orgName}`,
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      setUnmapOrg(null);
      await load();
    } catch (err) {
      handleActionError(err, 'Failed to remove tenant mapping');
    } finally {
      setUnmapping(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (notEnabled) {
    return (
      <div
        className="rounded-lg border bg-card p-6 text-sm text-muted-foreground"
        data-testid="ai-office-not-enabled"
      >
        <p className="font-medium text-foreground">
          Breeze AI for Office is not enabled on this instance.
        </p>
        <p className="mt-1">
          Set <code className="rounded bg-muted px-1">CLIENT_AI_ENTRA_CLIENT_ID</code> (the Entra
          add-in app registration) on the API and reload.
        </p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div
        className="rounded-lg border bg-card p-6 text-sm text-muted-foreground"
        data-testid="ai-office-orgs-load-error"
      >
        Failed to load organization status.{' '}
        <button
          type="button"
          className="text-primary underline"
          onClick={() => {
            setLoading(true);
            void load();
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  const wizardRow = wizardOrgId ? (rows.find((r) => r.orgId === wizardOrgId) ?? null) : null;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card">
        <div className="border-b px-6 py-4">
          <h2 className="text-lg font-semibold">Client organizations</h2>
          <p className="text-sm text-muted-foreground">
            Provision the Excel AI assistant per client org: map the Entra tenant, grant admin
            consent, enable the policy, deploy the add-in.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2">Organization</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">AI enabled</th>
                <th className="px-4 py-2">Entra tenant</th>
                <th className="px-4 py-2 text-right">Cost (MTD)</th>
                <th className="px-4 py-2 text-right">Messages (MTD)</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.orgId}
                  className="border-b last:border-0 hover:bg-muted/20"
                  data-testid={`ai-office-org-row-${row.orgId}`}
                >
                  <td className="px-4 py-2.5 font-medium">{row.orgName}</td>
                  <td className="px-4 py-2.5">
                    <StatusChip status={row.consentStatus} />
                  </td>
                  <td className="px-4 py-2.5">
                    {row.policyEnabled ? (
                      <span className="text-emerald-600 dark:text-emerald-400">Yes</span>
                    ) : (
                      <span className="text-muted-foreground">No</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                    {row.entraTenantId ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right">{formatCost(row.currentMonthCostCents)}</td>
                  <td className="px-4 py-2.5 text-right">{row.currentMonthMessages}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setWizardOrgId(row.orgId)}
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                        data-testid={`ai-office-wizard-open-${row.orgId}`}
                      >
                        <Settings2 className="h-3.5 w-3.5" /> {row.mapped ? 'Manage' : 'Set up'}
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenPolicy(row.orgId)}
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                        data-testid={`ai-office-policy-open-${row.orgId}`}
                      >
                        <SlidersHorizontal className="h-3.5 w-3.5" /> Policy
                      </button>
                      {row.mapped && (
                        <button
                          type="button"
                          onClick={() => setUnmapOrg(row)}
                          className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                          data-testid={`ai-office-unmap-${row.orgId}`}
                        >
                          <Unplug className="h-3.5 w-3.5" /> Unmap
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    No organizations
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {wizardRow && (
        <OnboardingWizard
          row={wizardRow}
          onClose={() => setWizardOrgId(null)}
          onChanged={() => void load()}
          onOpenPolicy={onOpenPolicy}
        />
      )}

      <ConfirmDialog
        open={unmapOrg !== null}
        onClose={() => setUnmapOrg(null)}
        onConfirm={() => void confirmUnmap()}
        title="Remove tenant mapping"
        message={
          unmapOrg
            ? `Users in ${unmapOrg.orgName}'s Entra tenant will no longer be able to sign in to the Excel assistant. The org policy and usage history are kept.`
            : ''
        }
        confirmLabel="Remove mapping"
        isLoading={unmapping}
        confirmTestId="ai-office-unmap-confirm"
      />
    </div>
  );
}

// ── Onboarding wizard (spec §9.1) ────────────────────────────────────────────

type WizardStep = 1 | 2 | 3 | 4;

function initialStep(row: OrgStatusRow): WizardStep {
  if (!row.mapped) return 1;
  if (row.consentStatus === 'pending') return 2;
  if (!row.policyEnabled) return 3;
  return 4;
}

interface ConsentInfo {
  url: string;
  tenantSegment: string;
  redirectUri: string;
}

function OnboardingWizard({
  row,
  onClose,
  onChanged,
  onOpenPolicy,
}: {
  row: OrgStatusRow;
  onClose: () => void;
  onChanged: () => void;
  onOpenPolicy: (orgId: string) => void;
}) {
  const [step, setStep] = useState<WizardStep>(() => initialStep(row));
  const [tenantId, setTenantId] = useState(row.entraTenantId ?? row.suggestedEntraTenantId ?? '');
  const [saving, setSaving] = useState(false);
  const [consent, setConsent] = useState<ConsentInfo | null>(null);
  const [consentError, setConsentError] = useState(false);

  // Step 2 needs the admin-consent URL (GET /client-ai/admin/orgs/:orgId/consent-url, Task 2).
  useEffect(() => {
    if (step !== 2) return;
    let cancelled = false;
    setConsent(null);
    setConsentError(false);
    fetchWithAuth(`/client-ai/admin/orgs/${row.orgId}/consent-url`)
      .then((r) =>
        r.ok ? (r.json() as Promise<ConsentInfo>) : Promise.reject(new Error(`HTTP ${r.status}`))
      )
      .then((data) => {
        if (!cancelled) setConsent(data);
      })
      .catch(() => {
        if (!cancelled) setConsentError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [step, row.orgId]);

  const tenantIdValid = ENTRA_TENANT_GUID_REGEX.test(tenantId.trim());

  const saveMapping = async () => {
    if (!tenantIdValid || saving) return;
    setSaving(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/client-ai/admin/orgs/${row.orgId}/tenant-mapping`, {
            method: 'PUT',
            body: JSON.stringify({ entraTenantId: tenantId.trim() }),
          }),
        errorFallback: 'Failed to save tenant mapping',
        successMessage: 'Tenant mapping saved',
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      onChanged();
      setStep(2);
    } catch (err) {
      // 409 tenant_already_mapped surfaces via runAction's error toast (the
      // API's deliberately opaque message — it never reveals the owning org).
      handleActionError(err, 'Failed to save tenant mapping');
    } finally {
      setSaving(false);
    }
  };

  const copyConsentUrl = async () => {
    if (!consent) return;
    try {
      await navigator.clipboard.writeText(consent.url);
      showToast({ type: 'success', message: 'Consent URL copied' });
    } catch {
      showToast({ type: 'error', message: 'Could not copy — select the URL manually' });
    }
  };

  const enablePolicy = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/client-ai/admin/orgs/${row.orgId}/policy`, {
            method: 'PUT',
            body: JSON.stringify({ enabled: true }),
          }),
        errorFallback: 'Failed to enable AI for Office',
        successMessage: `AI for Office enabled for ${row.orgName}`,
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      onChanged();
      setStep(4);
    } catch (err) {
      handleActionError(err, 'Failed to enable AI for Office');
    } finally {
      setSaving(false);
    }
  };

  const steps: { n: WizardStep; label: string }[] = [
    { n: 1, label: 'Tenant' },
    { n: 2, label: 'Consent' },
    { n: 3, label: 'Enable' },
    { n: 4, label: 'Deploy' },
  ];

  return (
    <Dialog open onClose={onClose} title={`Set up AI for Office — ${row.orgName}`} maxWidth="2xl" className="p-6">
      <h2 className="text-lg font-semibold">Set up AI for Office — {row.orgName}</h2>
      <div className="mt-3 flex items-center gap-2" data-testid="ai-office-wizard-steps">
        {steps.map((s, i) => (
          <div key={s.n} className="flex items-center gap-2">
            {i > 0 && <div className="h-px w-6 bg-border" />}
            <span
              className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ${
                step === s.n
                  ? 'bg-primary text-primary-foreground'
                  : step > s.n
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              {s.n}. {s.label}
            </span>
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="mt-5 space-y-3" data-testid="ai-office-wizard-step-1">
          <p className="text-sm text-muted-foreground">
            Map this org to its Microsoft Entra tenant (Directory ID). The mapping is the
            tenant-isolation linchpin — every Excel sign-in from this tenant lands in this org.
            {row.suggestedEntraTenantId && !row.entraTenantId
              ? ' Pre-filled from the org’s existing Microsoft 365 connection.'
              : ''}
          </p>
          <label className="block text-sm">
            <span className="text-muted-foreground">Entra tenant ID</span>
            <input
              type="text"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
              data-testid="ai-office-wizard-tenant-input"
            />
          </label>
          {tenantId.trim() !== '' && !tenantIdValid && (
            <p className="text-xs text-destructive">
              Must be a GUID (Entra admin center → Overview → Tenant ID).
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void saveMapping()}
              disabled={!tenantIdValid || saving}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
              data-testid="ai-office-wizard-save-mapping"
            >
              {saving ? 'Saving…' : 'Save & continue'}
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="mt-5 space-y-3" data-testid="ai-office-wizard-step-2">
          <p className="text-sm text-muted-foreground">
            A Microsoft 365 admin of the client tenant must grant admin consent to the Breeze AI
            for Office app. Send them this link (or open it yourself if you hold Global Admin in
            the client tenant):
          </p>
          {consentError && (
            <p className="text-sm text-destructive">Failed to load the consent URL. Close and retry.</p>
          )}
          {!consent && !consentError && (
            <p className="text-sm text-muted-foreground">
              <Loader2 className="inline h-4 w-4 animate-spin" /> Loading consent URL…
            </p>
          )}
          {consent && (
            <>
              <div className="flex items-center gap-2">
                <code
                  className="block flex-1 overflow-x-auto whitespace-nowrap rounded-md border bg-muted/40 px-3 py-2 text-xs"
                  data-testid="ai-office-consent-url"
                >
                  {consent.url}
                </code>
                <button
                  type="button"
                  onClick={() => void copyConsentUrl()}
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-2 text-xs hover:bg-muted"
                  data-testid="ai-office-consent-copy"
                  title="Copy URL"
                >
                  <ClipboardCopy className="h-4 w-4" />
                </button>
                <a
                  href={consent.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-2 text-xs hover:bg-muted"
                  title="Open in new tab"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
              <p className="text-xs text-muted-foreground">
                After granting, Microsoft redirects to a Breeze confirmation page. Consent shows as
                granted here once the first user signs in from Excel — there is no live poll
                against Microsoft (Plan-4 decision 1).
              </p>
            </>
          )}
          <div className="flex justify-between gap-2">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
              data-testid="ai-office-wizard-consent-done"
            >
              I&apos;ve granted consent
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="mt-5 space-y-3" data-testid="ai-office-wizard-step-3">
          <p className="text-sm text-muted-foreground">
            Enable the assistant for this org. This writes <code>enabled: true</code> to the org
            policy with safe defaults (all users, read/write with end-user approval, DLP redaction
            for financial/credential types). Tune everything in the policy editor afterwards.
          </p>
          <div className="flex justify-between gap-2">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => void enablePolicy()}
              disabled={saving}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
              data-testid="ai-office-wizard-enable"
            >
              {saving ? 'Enabling…' : row.policyEnabled ? 'Already enabled — continue' : 'Enable AI for Office'}
            </button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="mt-5 space-y-3" data-testid="ai-office-wizard-step-4">
          <p className="text-sm font-medium">Deploy the Excel add-in via Microsoft 365 centralized deployment</p>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>
              Sign in to the client tenant&apos;s{' '}
              <span className="font-medium text-foreground">Microsoft 365 admin center</span> →
              Settings → Integrated apps.
            </li>
            <li>
              Choose <span className="font-medium text-foreground">Upload custom apps</span> →
              Office add-in → provide the Breeze AI for Office manifest URL from your Breeze
              instance.
            </li>
            <li>
              Assign the add-in to everyone or to the user groups covered by this org&apos;s
              access policy.
            </li>
            <li>
              Deployment can take up to 24h to appear in users&apos; Excel ribbon (Home →
              Add-ins).
            </li>
            <li>Users sign in automatically with their Microsoft work account — no extra credentials.</li>
          </ol>
          <div className="flex justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                onOpenPolicy(row.orgId);
                onClose();
              }}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              data-testid="ai-office-wizard-open-policy"
            >
              Open policy editor
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
              data-testid="ai-office-wizard-done"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
```

- [ ] **Step 2: Write the component tests**

`apps/web/src/components/clientAi/OrgsTab.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OrgsTab from './OrgsTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG_A = '0c0c0c0c-1111-4222-8333-444455556666'; // not provisioned (with suggestion)
const ORG_B = '1d1d1d1d-1111-4222-8333-444455556666'; // consent pending
const ORG_C = '2e2e2e2e-1111-4222-8333-444455556666'; // active
const TID = '6f4f4f4f-1111-4222-8333-444455556666';

const baseRow = {
  mapped: false,
  entraTenantId: null as string | null,
  suggestedEntraTenantId: null as string | null,
  consentStatus: 'unknown' as 'unknown' | 'pending' | 'granted',
  policyEnabled: false,
  currentMonthCostCents: 0,
  currentMonthMessages: 0,
};

const ROWS = [
  { ...baseRow, orgId: ORG_A, orgName: 'Unprovisioned Org', suggestedEntraTenantId: TID },
  { ...baseRow, orgId: ORG_B, orgName: 'Pending Org', mapped: true, entraTenantId: TID, consentStatus: 'pending' as const },
  {
    ...baseRow,
    orgId: ORG_C,
    orgName: 'Active Org',
    mapped: true,
    entraTenantId: TID,
    consentStatus: 'granted' as const,
    policyEnabled: true,
    currentMonthCostCents: 1234,
    currentMonthMessages: 87,
  },
];

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

function mockApi() {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/client-ai/admin/orgs' && !init?.method) {
      return makeJsonResponse({ data: ROWS });
    }
    if (url === `/client-ai/admin/orgs/${ORG_A}/tenant-mapping` && init?.method === 'PUT') {
      return makeJsonResponse({
        mapping: { id: 'm1', orgId: ORG_A, entraTenantId: TID, createdAt: '', updatedAt: '' },
      });
    }
    if (url === `/client-ai/admin/orgs/${ORG_A}/consent-url` && !init?.method) {
      return makeJsonResponse({
        url: `https://login.microsoftonline.com/${TID}/adminconsent?client_id=x`,
        tenantSegment: TID,
        redirectUri: 'https://breeze.example/api/v1/client-ai/consent/callback',
      });
    }
    if (url === `/client-ai/admin/orgs/${ORG_C}/tenant-mapping` && init?.method === 'DELETE') {
      return makeJsonResponse({ mapping: null });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 500);
  });
}

describe('OrgsTab', () => {
  const onOpenPolicy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the three onboarding status chips', async () => {
    mockApi();
    render(<OrgsTab onOpenPolicy={onOpenPolicy} />);
    await waitFor(() => expect(screen.getByTestId('ai-office-status-unprovisioned')).toBeInTheDocument());
    expect(screen.getByTestId('ai-office-status-pending')).toBeInTheDocument();
    expect(screen.getByTestId('ai-office-status-active')).toBeInTheDocument();
    expect(screen.getByText('$12.34')).toBeInTheDocument(); // 1234 cents MTD
  });

  it('wizard step 1 pre-fills the suggested tenant and PUTs the exact mapping payload', async () => {
    mockApi();
    render(<OrgsTab onOpenPolicy={onOpenPolicy} />);
    await waitFor(() => expect(screen.getByTestId(`ai-office-wizard-open-${ORG_A}`)).toBeInTheDocument());

    fireEvent.click(screen.getByTestId(`ai-office-wizard-open-${ORG_A}`));
    const input = screen.getByTestId('ai-office-wizard-tenant-input') as HTMLInputElement;
    expect(input.value).toBe(TID); // pre-filled from suggestedEntraTenantId (M365 reuse audit)

    fireEvent.click(screen.getByTestId('ai-office-wizard-save-mapping'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    );
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(String(putCall![0])).toBe(`/client-ai/admin/orgs/${ORG_A}/tenant-mapping`);
    expect(JSON.parse(String(putCall![1]!.body))).toEqual({ entraTenantId: TID });

    // Advances to step 2 and loads the consent URL
    await waitFor(() => expect(screen.getByTestId('ai-office-wizard-step-2')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('ai-office-consent-url')).toBeInTheDocument());
  });

  it('unmap requires confirmation and DELETEs the mapping', async () => {
    mockApi();
    render(<OrgsTab onOpenPolicy={onOpenPolicy} />);
    await waitFor(() => expect(screen.getByTestId(`ai-office-unmap-${ORG_C}`)).toBeInTheDocument());

    fireEvent.click(screen.getByTestId(`ai-office-unmap-${ORG_C}`));
    fireEvent.click(screen.getByTestId('ai-office-unmap-confirm'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
    );
    const delCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(String(delCall![0])).toBe(`/client-ai/admin/orgs/${ORG_C}/tenant-mapping`);
  });

  it('shows the not-enabled notice when the admin group is dark-gated (404)', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'Breeze AI for Office is not enabled' }, false, 404));
    render(<OrgsTab onOpenPolicy={onOpenPolicy} />);
    await waitFor(() => expect(screen.getByTestId('ai-office-not-enabled')).toBeInTheDocument());
  });

  it('Policy button hands the orgId to onOpenPolicy', async () => {
    mockApi();
    render(<OrgsTab onOpenPolicy={onOpenPolicy} />);
    await waitFor(() => expect(screen.getByTestId(`ai-office-policy-open-${ORG_C}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`ai-office-policy-open-${ORG_C}`));
    expect(onOpenPolicy).toHaveBeenCalledWith(ORG_C);
  });
});
```

- [ ] **Step 3: Adopt into the WS-A guard**

In `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, append to `TARGET_GLOBS` (before the closing `];`, after `'src/components/tickets/TicketPartsCard.tsx',`):

```ts
  'src/components/clientAi/OrgsTab.tsx',
```

- [ ] **Step 4: Run the tests**

```bash
cd /Users/toddhebebrand/breeze/apps/web
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/components/clientAi/OrgsTab.test.tsx src/lib/__tests__/no-silent-mutations.test.ts
```

Expected: all PASS (the guard proves every mutating call in OrgsTab goes through `runAction`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/clientAi/OrgsTab.tsx apps/web/src/components/clientAi/OrgsTab.test.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(client-ai-web): org status table + 4-step onboarding wizard" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: PolicyEditor — full policy form + DLP rule builder with live regex test

Spec §9.2. Edits every `client_ai_org_policies` knob through Plan 1's `GET/PUT /client-ai/admin/orgs/:orgId/policy` (`putPolicySchema` is **strict** — the payload below uses exactly its keys) and the user picker from Task 2's `GET /orgs/:orgId/users`. The DLP section writes the Task-1 `clientAiDlpConfigSchema` shape: `builtins` map over the six detectors + `customRules[{id,name,pattern,action}]`, with a live client-side regex test box (`new RegExp` in try/catch over a sample textarea — evaluated locally, never sent anywhere).

**Files:**
- Create: apps/web/src/components/clientAi/PolicyEditor.tsx
- Create: apps/web/src/components/clientAi/PolicyEditor.test.tsx
- Modify: apps/web/src/lib/__tests__/no-silent-mutations.test.ts (`TARGET_GLOBS`)

- [ ] **Step 1: Write the component**

`apps/web/src/components/clientAi/PolicyEditor.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { runAction, handleActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';

/**
 * AI for Office — per-org policy editor (spec §9.2). Reached via
 * #policy/<orgId> from the OrgsTab. Endpoints (Plan 1 + Plan-4 Task 2):
 *   GET /client-ai/admin/orgs/:orgId/policy  → { policy }
 *   PUT /client-ai/admin/orgs/:orgId/policy  ← putPolicySchema (STRICT — keys below only)
 *   GET /client-ai/admin/orgs/:orgId/users   → { data: entra portal users } (decision 9)
 * The dlpConfig payload is the Plan-4 Task-1 clientAiDlpConfigSchema contract.
 */

type DlpAction = 'redact' | 'block' | 'log' | 'off';
type DlpBuiltinKey = 'creditCard' | 'ssn' | 'iban' | 'apiKey' | 'email' | 'phone';
type CustomRule = { id: string; name: string; pattern: string; action: DlpAction };

const DLP_ACTIONS: { value: DlpAction; label: string }[] = [
  { value: 'redact', label: 'Redact' },
  { value: 'block', label: 'Block request' },
  { value: 'log', label: 'Log only' },
  { value: 'off', label: 'Off' },
];

// Mirrors CLIENT_AI_DLP_DEFAULT_BUILTINS (apps/api/src/routes/clientAi/schemas.ts,
// Plan-4 Task 1): redact financial/credential types, email/phone off (spec §6).
const DLP_BUILTINS: { key: DlpBuiltinKey; label: string; defaultAction: DlpAction }[] = [
  { key: 'creditCard', label: 'Credit card numbers (Luhn-validated)', defaultAction: 'redact' },
  { key: 'ssn', label: 'SSN / national IDs', defaultAction: 'redact' },
  { key: 'iban', label: 'IBAN account numbers', defaultAction: 'redact' },
  { key: 'apiKey', label: 'API keys & tokens', defaultAction: 'redact' },
  { key: 'email', label: 'Email addresses', defaultAction: 'off' },
  { key: 'phone', label: 'Phone numbers', defaultAction: 'off' },
];

// The models priced in apps/api/src/services/aiCostTracker.ts:17-18. Empty
// selection = all available models (Plan-1 default allowedModels: []).
const KNOWN_MODELS: { id: string; label: string }[] = [
  { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

interface PolicyDto {
  orgId: string;
  enabled: boolean;
  userAccess: 'all' | 'selected';
  selectedUserIds: string[];
  allowedProviders: string[];
  allowedModels: string[];
  writeMode: 'readwrite' | 'readonly';
  dlpConfig: {
    builtins?: Partial<Record<DlpBuiltinKey, DlpAction>>;
    customRules?: CustomRule[];
  } | null;
  dailyBudgetCents: number | null;
  monthlyBudgetCents: number | null;
  perUserMessagesPerMinute: number;
  orgMessagesPerHour: number;
  retentionDays: number | null;
  branding: { displayName?: string | null; logoUrl?: string | null } | null;
}

interface EntraUser {
  id: string;
  email: string;
  name: string | null;
  lastLoginAt: string | null;
}

function defaultBuiltins(): Record<DlpBuiltinKey, DlpAction> {
  return Object.fromEntries(DLP_BUILTINS.map((b) => [b.key, b.defaultAction])) as Record<
    DlpBuiltinKey,
    DlpAction
  >;
}

/** Live regex test (spec §9.2): compile client-side, count matches in the sample. */
export function testPattern(
  pattern: string,
  sample: string
): { ok: true; matches: number } | { ok: false; error: string } {
  try {
    const re = new RegExp(pattern, 'g');
    return { ok: true, matches: sample ? (sample.match(re) ?? []).length : 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid pattern' };
  }
}

export default function PolicyEditor({ orgId, onBack }: { orgId: string; onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [orgUsers, setOrgUsers] = useState<EntraUser[]>([]);

  // Form state — buildPayload() below is the single source of the PUT body.
  const [enabled, setEnabled] = useState(false);
  const [userAccess, setUserAccess] = useState<'all' | 'selected'>('all');
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [allowedModels, setAllowedModels] = useState<string[]>([]);
  const [writeMode, setWriteMode] = useState<'readwrite' | 'readonly'>('readwrite');
  const [builtins, setBuiltins] = useState<Record<DlpBuiltinKey, DlpAction>>(defaultBuiltins);
  const [customRules, setCustomRules] = useState<CustomRule[]>([]);
  const [dailyBudgetDollars, setDailyBudgetDollars] = useState('');
  const [monthlyBudgetDollars, setMonthlyBudgetDollars] = useState('');
  const [perUserPerMinute, setPerUserPerMinute] = useState('10');
  const [orgPerHour, setOrgPerHour] = useState('500');
  const [retentionDays, setRetentionDays] = useState('');
  const [brandDisplayName, setBrandDisplayName] = useState('');
  const [brandLogoUrl, setBrandLogoUrl] = useState('');
  const [dlpSample, setDlpSample] = useState('');

  const load = useCallback(async () => {
    try {
      setLoadError(false);
      const [policyRes, usersRes] = await Promise.all([
        fetchWithAuth(`/client-ai/admin/orgs/${orgId}/policy`),
        fetchWithAuth(`/client-ai/admin/orgs/${orgId}/users`),
      ]);
      if (policyRes.status === 401 || usersRes.status === 401) {
        void navigateTo('/login', { replace: true });
        return;
      }
      if (!policyRes.ok) throw new Error(`HTTP ${policyRes.status}`);
      const { policy } = (await policyRes.json()) as { policy: PolicyDto };
      setEnabled(policy.enabled);
      setUserAccess(policy.userAccess);
      setSelectedUserIds(policy.selectedUserIds ?? []);
      setAllowedModels(policy.allowedModels ?? []);
      setWriteMode(policy.writeMode);
      const cfg = policy.dlpConfig ?? {};
      setBuiltins({ ...defaultBuiltins(), ...(cfg.builtins ?? {}) });
      setCustomRules(cfg.customRules ?? []);
      setDailyBudgetDollars(
        policy.dailyBudgetCents != null ? (policy.dailyBudgetCents / 100).toFixed(2) : ''
      );
      setMonthlyBudgetDollars(
        policy.monthlyBudgetCents != null ? (policy.monthlyBudgetCents / 100).toFixed(2) : ''
      );
      setPerUserPerMinute(String(policy.perUserMessagesPerMinute));
      setOrgPerHour(String(policy.orgMessagesPerHour));
      setRetentionDays(policy.retentionDays != null ? String(policy.retentionDays) : '');
      const branding = policy.branding ?? {};
      setBrandDisplayName(branding.displayName ?? '');
      setBrandLogoUrl(branding.logoUrl ?? '');
      if (usersRes.ok) {
        const usersBody = (await usersRes.json()) as { data: EntraUser[] };
        setOrgUsers(usersBody.data ?? []);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const ruleResults = useMemo(
    () => new Map(customRules.map((r) => [r.id, testPattern(r.pattern, dlpSample)])),
    [customRules, dlpSample]
  );

  const dollarsToCents = (v: string): number | null => {
    const t = v.trim();
    if (!t) return null;
    const n = Number.parseFloat(t);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  };
  const toInt = (v: string, fallback: number): number => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  /** Exactly putPolicySchema's keys (Plan 1; dlpConfig tightened by Plan-4 Task 1). */
  const buildPayload = () => ({
    enabled,
    userAccess,
    selectedUserIds: userAccess === 'selected' ? selectedUserIds : [],
    allowedModels,
    writeMode,
    dlpConfig: {
      builtins,
      customRules: customRules.map((r) => ({
        id: r.id,
        name: r.name.trim(),
        pattern: r.pattern,
        action: r.action,
      })),
    },
    dailyBudgetCents: dollarsToCents(dailyBudgetDollars),
    monthlyBudgetCents: dollarsToCents(monthlyBudgetDollars),
    perUserMessagesPerMinute: toInt(perUserPerMinute, 10),
    orgMessagesPerHour: toInt(orgPerHour, 500),
    retentionDays: retentionDays.trim() ? toInt(retentionDays, 1) : null,
    branding: {
      displayName: brandDisplayName.trim() || null,
      logoUrl: brandLogoUrl.trim() || null,
    },
  });

  const save = async () => {
    if (saving) return;
    // Client-side pre-validation of the DLP contract (the server schema
    // rejects non-compiling patterns with a 400 — fail here with a clear toast).
    for (const rule of customRules) {
      if (!rule.name.trim()) {
        showToast({ type: 'error', message: 'Every custom DLP rule needs a name' });
        return;
      }
      const result = testPattern(rule.pattern, '');
      if (!result.ok) {
        showToast({
          type: 'error',
          message: `DLP rule "${rule.name}" has an invalid pattern — fix it before saving`,
        });
        return;
      }
    }
    setSaving(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/client-ai/admin/orgs/${orgId}/policy`, {
            method: 'PUT',
            body: JSON.stringify(buildPayload()),
          }),
        errorFallback: 'Failed to save policy',
        successMessage: 'Policy saved',
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
    } catch (err) {
      handleActionError(err, 'Failed to save policy');
    } finally {
      setSaving(false);
    }
  };

  const toggleModel = (id: string) =>
    setAllowedModels((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  const toggleUser = (id: string) =>
    setSelectedUserIds((prev) => (prev.includes(id) ? prev.filter((u) => u !== id) : [...prev, id]));
  const updateRule = (id: string, patch: Partial<CustomRule>) =>
    setCustomRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addRule = () =>
    setCustomRules((prev) => [...prev, { id: crypto.randomUUID(), name: '', pattern: '', action: 'redact' }]);
  const removeRule = (id: string) => setCustomRules((prev) => prev.filter((r) => r.id !== id));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div
        className="rounded-lg border bg-card p-6 text-sm text-muted-foreground"
        data-testid="ai-office-policy-load-error"
      >
        Failed to load the org policy.{' '}
        <button
          type="button"
          className="text-primary underline"
          onClick={() => {
            setLoading(true);
            void load();
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="ai-office-policy-editor">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-sm hover:bg-muted"
          data-testid="ai-office-policy-back"
        >
          <ArrowLeft className="h-4 w-4" /> Organizations
        </button>
        <div>
          <h2 className="text-lg font-semibold">Org policy</h2>
          <p className="text-sm text-muted-foreground">
            Everything this client org&apos;s Excel assistant is allowed to do.
          </p>
        </div>
      </div>

      {/* General */}
      <section className="rounded-lg border bg-card p-6">
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          General
        </h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block text-sm">
            <span className="text-muted-foreground">Assistant</span>
            <select
              value={enabled ? 'true' : 'false'}
              onChange={(e) => setEnabled(e.target.value === 'true')}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-enabled"
            >
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Workbook access</span>
            <select
              value={writeMode}
              onChange={(e) => setWriteMode(e.target.value as 'readwrite' | 'readonly')}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-writemode"
            >
              <option value="readwrite">Read &amp; write (writes approval-gated by the end user)</option>
              <option value="readonly">Read only (write tools removed from the model)</option>
            </select>
          </label>
          <div className="text-sm">
            <span className="text-muted-foreground">Allowed models</span>
            <div className="mt-1 space-y-1.5">
              {KNOWN_MODELS.map((m) => (
                <label key={m.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={allowedModels.includes(m.id)}
                    onChange={() => toggleModel(m.id)}
                    className="rounded border-border"
                    data-testid={`ai-office-policy-model-${m.id}`}
                  />
                  {m.label}
                </label>
              ))}
              <p className="text-xs text-muted-foreground">No selection = all available models.</p>
            </div>
          </div>
        </div>
      </section>

      {/* User access */}
      <section className="rounded-lg border bg-card p-6">
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          User access
        </h3>
        <label className="block max-w-xs text-sm">
          <span className="text-muted-foreground">Who can use the assistant</span>
          <select
            value={userAccess}
            onChange={(e) => setUserAccess(e.target.value as 'all' | 'selected')}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            data-testid="ai-office-policy-useraccess"
          >
            <option value="all">All users in the mapped tenant</option>
            <option value="selected">Only selected users</option>
          </select>
        </label>
        {userAccess === 'selected' && (
          <div
            className="mt-3 max-h-56 space-y-1.5 overflow-y-auto rounded-md border p-3"
            data-testid="ai-office-policy-userlist"
          >
            {orgUsers.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No users have signed in from Excel yet — users appear here after their first
                sign-in. Until then, leave access on &quot;All users&quot;.
              </p>
            )}
            {orgUsers.map((u) => (
              <label key={u.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedUserIds.includes(u.id)}
                  onChange={() => toggleUser(u.id)}
                  className="rounded border-border"
                  data-testid={`ai-office-policy-user-${u.id}`}
                />
                <span>{u.email}</span>
                {u.name && <span className="text-xs text-muted-foreground">{u.name}</span>}
              </label>
            ))}
          </div>
        )}
      </section>

      {/* Budgets & rate limits */}
      <section className="rounded-lg border bg-card p-6">
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Budgets &amp; rate limits
        </h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block text-sm">
            <span className="text-muted-foreground">Daily budget ($)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={dailyBudgetDollars}
              onChange={(e) => setDailyBudgetDollars(e.target.value)}
              placeholder="No limit"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-daily-budget"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Monthly budget ($)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={monthlyBudgetDollars}
              onChange={(e) => setMonthlyBudgetDollars(e.target.value)}
              placeholder="No limit"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-monthly-budget"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Messages/min per user</span>
            <input
              type="number"
              min="1"
              max="600"
              value={perUserPerMinute}
              onChange={(e) => setPerUserPerMinute(e.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-per-user-rate"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Messages/hour per org</span>
            <input
              type="number"
              min="1"
              value={orgPerHour}
              onChange={(e) => setOrgPerHour(e.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-org-rate"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Transcript retention (days)</span>
            <input
              type="number"
              min="1"
              max="3650"
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
              placeholder="Keep forever"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-retention"
            />
          </label>
        </div>
      </section>

      {/* Branding */}
      <section className="rounded-lg border bg-card p-6">
        <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Branding
        </h3>
        <p className="mb-4 text-sm text-muted-foreground">
          Shown in the add-in footer: &quot;Governed by your IT provider&quot; — the white-label
          hook (spec §11).
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-muted-foreground">Display name</span>
            <input
              type="text"
              value={brandDisplayName}
              onChange={(e) => setBrandDisplayName(e.target.value)}
              placeholder="Your MSP name"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-brand-name"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Logo URL</span>
            <input
              type="url"
              value={brandLogoUrl}
              onChange={(e) => setBrandLogoUrl(e.target.value)}
              placeholder="https://…/logo.png"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-brand-logo"
            />
          </label>
        </div>
      </section>

      {/* DLP */}
      <section className="rounded-lg border bg-card p-6">
        <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Data loss prevention
        </h3>
        <p className="mb-4 text-sm text-muted-foreground">
          Every payload leaving Breeze for the model is scanned (spec §6). Redacted values are
          stored redacted — the audit trail never keeps the sensitive form.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {DLP_BUILTINS.map((b) => (
            <label key={b.key} className="block text-sm">
              <span className="text-muted-foreground">{b.label}</span>
              <select
                value={builtins[b.key]}
                onChange={(e) =>
                  setBuiltins((prev) => ({ ...prev, [b.key]: e.target.value as DlpAction }))
                }
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                data-testid={`ai-office-policy-dlp-${b.key}`}
              >
                {DLP_ACTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>

        <div className="mt-6">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">Custom rules</h4>
            <button
              type="button"
              onClick={addRule}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
              data-testid="ai-office-policy-dlp-add-rule"
            >
              <Plus className="h-3.5 w-3.5" /> Add rule
            </button>
          </div>
          {customRules.length > 0 && (
            <label className="mt-3 block text-sm">
              <span className="text-muted-foreground">
                Test sample (paste representative cell data — evaluated locally, never sent
                anywhere)
              </span>
              <textarea
                value={dlpSample}
                onChange={(e) => setDlpSample(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
                data-testid="ai-office-policy-dlp-sample"
              />
            </label>
          )}
          <div className="mt-3 space-y-3">
            {customRules.map((rule, idx) => {
              const result = ruleResults.get(rule.id);
              return (
                <div key={rule.id} className="rounded-md border p-3" data-testid={`ai-office-policy-dlp-rule-${idx}`}>
                  <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto_auto]">
                    <input
                      type="text"
                      value={rule.name}
                      onChange={(e) => updateRule(rule.id, { name: e.target.value })}
                      placeholder="Rule name"
                      className="rounded-md border bg-background px-3 py-2 text-sm"
                      data-testid={`ai-office-policy-dlp-rule-name-${idx}`}
                    />
                    <input
                      type="text"
                      value={rule.pattern}
                      onChange={(e) => updateRule(rule.id, { pattern: e.target.value })}
                      placeholder="Regular expression, e.g. PRJ-\d{4}"
                      className="rounded-md border bg-background px-3 py-2 font-mono text-sm"
                      data-testid={`ai-office-policy-dlp-rule-pattern-${idx}`}
                    />
                    <select
                      value={rule.action}
                      onChange={(e) => updateRule(rule.id, { action: e.target.value as DlpAction })}
                      className="rounded-md border bg-background px-3 py-2 text-sm"
                      data-testid={`ai-office-policy-dlp-rule-action-${idx}`}
                    >
                      {DLP_ACTIONS.filter((a) => a.value !== 'off').map((a) => (
                        <option key={a.value} value={a.value}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => removeRule(rule.id)}
                      className="rounded-md border px-2 py-2 text-destructive hover:bg-destructive/10"
                      title="Remove rule"
                      data-testid={`ai-office-policy-dlp-rule-remove-${idx}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  {result && rule.pattern.trim() !== '' && (
                    <p
                      className={`mt-1.5 text-xs ${result.ok ? 'text-muted-foreground' : 'text-destructive'}`}
                      data-testid={`ai-office-policy-dlp-rule-result-${idx}`}
                    >
                      {result.ok
                        ? dlpSample
                          ? `${result.matches} match${result.matches === 1 ? '' : 'es'} in the sample`
                          : 'Pattern compiles — add a test sample above to see matches'
                        : `Pattern error: ${result.error}`}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          data-testid="ai-office-policy-save"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save policy
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the component tests**

`apps/web/src/components/clientAi/PolicyEditor.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PolicyEditor, { testPattern } from './PolicyEditor';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const USER_1 = 'beefbeef-1111-4222-8333-444455556666';

// Plan-1 getOrgPolicy defaults (admin.test.ts fixture).
const DEFAULT_POLICY = {
  orgId: ORG_ID,
  enabled: false,
  userAccess: 'all',
  selectedUserIds: [],
  allowedProviders: ['anthropic'],
  allowedModels: [],
  writeMode: 'readwrite',
  dlpConfig: {},
  dailyBudgetCents: null,
  monthlyBudgetCents: null,
  perUserMessagesPerMinute: 10,
  orgMessagesPerHour: 500,
  retentionDays: null,
  branding: {},
};

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

function mockApi(policy: unknown = DEFAULT_POLICY) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/client-ai/admin/orgs/${ORG_ID}/policy` && !init?.method) {
      return makeJsonResponse({ policy });
    }
    if (url === `/client-ai/admin/orgs/${ORG_ID}/policy` && init?.method === 'PUT') {
      return makeJsonResponse({ policy });
    }
    if (url === `/client-ai/admin/orgs/${ORG_ID}/users` && !init?.method) {
      return makeJsonResponse({
        data: [{ id: USER_1, email: 'a@contoso.com', name: 'A', lastLoginAt: null }],
      });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 500);
  });
}

describe('PolicyEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves the exact putPolicySchema payload', async () => {
    mockApi();
    render(<PolicyEditor orgId={ORG_ID} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('ai-office-policy-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('ai-office-policy-enabled'), { target: { value: 'true' } });
    fireEvent.change(screen.getByTestId('ai-office-policy-writemode'), { target: { value: 'readonly' } });
    fireEvent.click(screen.getByTestId('ai-office-policy-model-claude-sonnet-4-5-20250929'));
    fireEvent.change(screen.getByTestId('ai-office-policy-monthly-budget'), { target: { value: '25.00' } });
    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-ssn'), { target: { value: 'block' } });
    fireEvent.click(screen.getByTestId('ai-office-policy-dlp-add-rule'));
    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-rule-name-0'), { target: { value: 'Project codes' } });
    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-rule-pattern-0'), { target: { value: 'PRJ-\\d{4}' } });
    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-rule-action-0'), { target: { value: 'block' } });
    fireEvent.change(screen.getByTestId('ai-office-policy-brand-name'), { target: { value: 'Lantern IT' } });
    fireEvent.click(screen.getByTestId('ai-office-policy-save'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    );
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(String(putCall![0])).toBe(`/client-ai/admin/orgs/${ORG_ID}/policy`);
    const body = JSON.parse(String(putCall![1]!.body));
    expect(body).toEqual({
      enabled: true,
      userAccess: 'all',
      selectedUserIds: [],
      allowedModels: ['claude-sonnet-4-5-20250929'],
      writeMode: 'readonly',
      dlpConfig: {
        builtins: {
          creditCard: 'redact',
          ssn: 'block',
          iban: 'redact',
          apiKey: 'redact',
          email: 'off',
          phone: 'off',
        },
        customRules: [
          { id: expect.any(String), name: 'Project codes', pattern: 'PRJ-\\d{4}', action: 'block' },
        ],
      },
      dailyBudgetCents: null,
      monthlyBudgetCents: 2500,
      perUserMessagesPerMinute: 10,
      orgMessagesPerHour: 500,
      retentionDays: null,
      branding: { displayName: 'Lantern IT', logoUrl: null },
    });
  });

  it('sends selectedUserIds when access is "selected"', async () => {
    mockApi();
    render(<PolicyEditor orgId={ORG_ID} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('ai-office-policy-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('ai-office-policy-useraccess'), { target: { value: 'selected' } });
    fireEvent.click(screen.getByTestId(`ai-office-policy-user-${USER_1}`));
    fireEvent.click(screen.getByTestId('ai-office-policy-save'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    );
    const body = JSON.parse(
      String(fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')![1]!.body)
    );
    expect(body.userAccess).toBe('selected');
    expect(body.selectedUserIds).toEqual([USER_1]);
  });

  it('blocks save and toasts when a custom rule pattern does not compile', async () => {
    mockApi();
    render(<PolicyEditor orgId={ORG_ID} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('ai-office-policy-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-office-policy-dlp-add-rule'));
    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-rule-name-0'), { target: { value: 'Broken' } });
    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-rule-pattern-0'), { target: { value: '(' } });
    fireEvent.click(screen.getByTestId('ai-office-policy-save'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
    );
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('live regex test box shows match counts and compile errors', async () => {
    mockApi();
    render(<PolicyEditor orgId={ORG_ID} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('ai-office-policy-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-office-policy-dlp-add-rule'));
    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-rule-pattern-0'), { target: { value: 'PRJ-\\d{4}' } });
    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-sample'), {
      target: { value: 'PRJ-0001 and PRJ-0002 but not PRJ-1' },
    });
    expect(screen.getByTestId('ai-office-policy-dlp-rule-result-0').textContent).toContain('2 matches');

    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-rule-pattern-0'), { target: { value: '(' } });
    expect(screen.getByTestId('ai-office-policy-dlp-rule-result-0').textContent).toContain('Pattern error');
  });

  it('testPattern counts matches and reports compile errors', () => {
    expect(testPattern('\\d+', 'a1 b22')).toEqual({ ok: true, matches: 2 });
    expect(testPattern('([', 'x').ok).toBe(false);
  });
});
```

- [ ] **Step 3: Adopt into the WS-A guard**

Append to `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (after the OrgsTab line from Task 8):

```ts
  'src/components/clientAi/PolicyEditor.tsx',
```

- [ ] **Step 4: Run the tests**

```bash
cd /Users/toddhebebrand/breeze/apps/web
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/components/clientAi/PolicyEditor.test.tsx src/lib/__tests__/no-silent-mutations.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/clientAi/PolicyEditor.tsx apps/web/src/components/clientAi/PolicyEditor.test.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(client-ai-web): full org policy editor with DLP rule builder + live regex test" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: SessionsTab — client-session audit viewer with transcript drawer + flag/unflag

Spec §9.3. Consumes Task 3's endpoints exactly: `GET /client-ai/admin/sessions` (filters `orgId`, `clientUserId`, `from`, `to`, `flagged`, `limit`, `offset` → `{data, pagination}`), `GET /sessions/:id` (`{session, messages[+redactionCounts], toolExecutions}`), `POST/DELETE /sessions/:id/flag`. Mirrors the technician flagged-sessions UI (`AiUsagePage.tsx:354-423` — flagged row accent, flag chip, flagged-only toggle) plus the transcript drill-in the technician UI doesn't have.

**Files:**
- Create: apps/web/src/components/clientAi/SessionsTab.tsx
- Create: apps/web/src/components/clientAi/SessionsTab.test.tsx
- Modify: apps/web/src/lib/__tests__/no-silent-mutations.test.ts (`TARGET_GLOBS`)

- [ ] **Step 1: Write the component**

`apps/web/src/components/clientAi/SessionsTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Flag, FlagOff, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { Dialog } from '../shared/Dialog';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { runAction, handleActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';

/**
 * AI for Office — client-session audit viewer (spec §9.3). excel_client
 * sessions only (the API constrains this — Plan-4 Task 3). Transcript shows
 * redaction badges derived from redactionCounts (decision 3: counted
 * [REDACTED:type] markers, since ai_messages stores the redacted form),
 * workbook-context chips from tool inputs, and the tool approval trail from
 * ai_tool_executions. Flag/unflag mirror the technician machinery with
 * client_ai.* audit actions.
 */

const PAGE_SIZE = 50;

/** Row shape of GET /client-ai/admin/sessions (Plan-4 Task 3). */
interface SessionListRow {
  id: string;
  orgId: string;
  orgName: string | null;
  clientUserId: string | null;
  userEmail: string | null;
  title: string | null;
  startedAt: string;
  lastActivityAt: string | null;
  turnCount: number;
  totalCostCents: number;
  flaggedAt: string | null;
  flagReason: string | null;
  status: string;
}

interface TranscriptMessage {
  id: string;
  role: string;
  content: string | null;
  contentBlocks: unknown;
  toolName: string | null;
  toolInput: unknown;
  toolOutput: unknown;
  createdAt: string;
  /** Derived per message by the API: [REDACTED:type] marker counts. */
  redactionCounts: Record<string, number>;
}

interface ToolExecution {
  id: string;
  toolName: string;
  toolInput: unknown;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

interface SessionDetailSession {
  id: string;
  orgId: string;
  orgName: string | null;
  clientUserId: string | null;
  userEmail: string | null;
  title: string | null;
  model: string;
  status: string;
  turnCount: number;
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  flaggedAt: string | null;
  flaggedBy: string | null;
  flagReason: string | null;
  createdAt: string;
  lastActivityAt: string | null;
}

interface SessionDetail {
  session: SessionDetailSession;
  messages: TranscriptMessage[];
  toolExecutions: ToolExecution[];
}

const formatCost = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const formatTime = (iso: string) => new Date(iso).toLocaleString();

/** Workbook-context chips (spec §9.3): tool name + range/sheet from toolInput. */
function workbookChips(m: TranscriptMessage): string[] {
  const chips: string[] = [];
  if (m.toolName) chips.push(m.toolName);
  const input = m.toolInput as Record<string, unknown> | null;
  if (input && typeof input.range === 'string') chips.push(input.range);
  if (input && typeof input.sheet === 'string') chips.push(`Sheet: ${input.sheet}`);
  return chips;
}

function ToolStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed:
      'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400',
    approved:
      'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-400',
    pending:
      'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400',
    rejected:
      'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400',
    failed:
      'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400',
  };
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs ${styles[status] ?? 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-500/30 dark:bg-slate-500/10 dark:text-slate-400'}`}
    >
      {status}
    </span>
  );
}

export default function SessionsTab() {
  // Filters
  const [orgs, setOrgs] = useState<{ orgId: string; orgName: string }[]>([]);
  const [orgUsers, setOrgUsers] = useState<{ id: string; email: string }[]>([]);
  const [orgFilter, setOrgFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  // List
  const [rows, setRows] = useState<SessionListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // Detail drawer
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // Flag/unflag
  const [flagOpen, setFlagOpen] = useState(false);
  const [flagReason, setFlagReason] = useState('');
  const [unflagOpen, setUnflagOpen] = useState(false);
  const [mutating, setMutating] = useState(false);

  // Org names for the filter select (the Task-2 status endpoint already has them).
  useEffect(() => {
    void fetchWithAuth('/client-ai/admin/orgs')
      .then((r) => (r.ok ? (r.json() as Promise<{ data?: { orgId: string; orgName: string }[] }>) : null))
      .then((b) => {
        if (b?.data) setOrgs(b.data.map(({ orgId, orgName }) => ({ orgId, orgName })));
      })
      .catch(() => {});
  }, []);

  // User filter options once an org is chosen (GET /orgs/:orgId/users, decision 9 —
  // the API filter is clientUserId, a portal_users UUID, so free-text won't do).
  useEffect(() => {
    setOrgUsers([]);
    setUserFilter('');
    if (!orgFilter) return;
    let cancelled = false;
    void fetchWithAuth(`/client-ai/admin/orgs/${orgFilter}/users`)
      .then((r) => (r.ok ? (r.json() as Promise<{ data?: { id: string; email: string }[] }>) : null))
      .then((b) => {
        if (!cancelled && b?.data) setOrgUsers(b.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orgFilter]);

  const loadSessions = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(false);
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (orgFilter) qs.set('orgId', orgFilter);
      if (userFilter) qs.set('clientUserId', userFilter);
      if (fromDate) qs.set('from', fromDate);
      if (toDate) qs.set('to', `${toDate}T23:59:59.999Z`); // include the whole end day
      if (flaggedOnly) qs.set('flagged', 'true');
      const res = await fetchWithAuth(`/client-ai/admin/sessions?${qs.toString()}`);
      if (res.status === 401) {
        void navigateTo('/login', { replace: true });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        data: SessionListRow[];
        pagination: { total: number; limit: number; offset: number };
      };
      setRows(body.data ?? []);
      setTotal(body.pagination?.total ?? 0);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgFilter, userFilter, fromDate, toDate, flaggedOnly, offset]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const loadDetail = useCallback(async (sessionId: string) => {
    try {
      setDetailLoading(true);
      const res = await fetchWithAuth(`/client-ai/admin/sessions/${sessionId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetail((await res.json()) as SessionDetail);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const openDetail = (sessionId: string) => {
    setDetailId(sessionId);
    setDetail(null);
    void loadDetail(sessionId);
  };
  const closeDetail = () => {
    setDetailId(null);
    setDetail(null);
  };

  const flagSession = async () => {
    if (!detailId || mutating) return;
    setMutating(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/client-ai/admin/sessions/${detailId}/flag`, {
            method: 'POST',
            // flagSessionSchema: reason is string-or-absent (null is rejected).
            body: JSON.stringify(flagReason.trim() ? { reason: flagReason.trim() } : {}),
          }),
        errorFallback: 'Failed to flag session',
        successMessage: 'Session flagged',
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      setFlagOpen(false);
      setFlagReason('');
      await Promise.all([loadDetail(detailId), loadSessions()]);
    } catch (err) {
      handleActionError(err, 'Failed to flag session');
    } finally {
      setMutating(false);
    }
  };

  const unflagSession = async () => {
    if (!detailId || mutating) return;
    setMutating(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/client-ai/admin/sessions/${detailId}/flag`, { method: 'DELETE' }),
        errorFallback: 'Failed to unflag session',
        successMessage: 'Session unflagged',
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      setUnflagOpen(false);
      await Promise.all([loadDetail(detailId), loadSessions()]);
    } catch (err) {
      handleActionError(err, 'Failed to unflag session');
    } finally {
      setMutating(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">
          Organization
          <select
            value={orgFilter}
            onChange={(e) => {
              setOrgFilter(e.target.value);
              setOffset(0);
            }}
            className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm"
            data-testid="ai-office-sessions-org"
          >
            <option value="">All organizations</option>
            {orgs.map((o) => (
              <option key={o.orgId} value={o.orgId}>
                {o.orgName}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          User
          <select
            value={userFilter}
            onChange={(e) => {
              setUserFilter(e.target.value);
              setOffset(0);
            }}
            disabled={!orgFilter}
            className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
            data-testid="ai-office-sessions-user"
          >
            <option value="">All users</option>
            {orgUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          From
          <input
            type="date"
            value={fromDate}
            onChange={(e) => {
              setFromDate(e.target.value);
              setOffset(0);
            }}
            className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm"
            data-testid="ai-office-sessions-from"
          />
        </label>
        <label className="text-xs">
          To
          <input
            type="date"
            value={toDate}
            onChange={(e) => {
              setToDate(e.target.value);
              setOffset(0);
            }}
            className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm"
            data-testid="ai-office-sessions-to"
          />
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={flaggedOnly}
            onChange={(e) => {
              setFlaggedOnly(e.target.checked);
              setOffset(0);
            }}
            className="rounded border-border"
            data-testid="ai-office-sessions-flagged"
          />
          Flagged only
        </label>
      </div>

      {/* Session table */}
      <div className="rounded-lg border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <div className="p-6 text-sm text-muted-foreground" data-testid="ai-office-sessions-load-error">
            Failed to load sessions.{' '}
            <button type="button" className="text-primary underline" onClick={() => void loadSessions()}>
              Retry
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2">Started</th>
                  <th className="px-4 py-2">Organization</th>
                  <th className="px-4 py-2">User</th>
                  <th className="px-4 py-2">Title</th>
                  <th className="px-4 py-2 text-right">Turns</th>
                  <th className="px-4 py-2 text-right">Cost</th>
                  <th className="px-4 py-2">Flagged</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => openDetail(s.id)}
                    className={`cursor-pointer border-b last:border-0 hover:bg-muted/20 ${s.flaggedAt ? 'border-l-2 border-l-amber-500' : ''}`}
                    data-testid={`ai-office-session-row-${s.id}`}
                  >
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{formatTime(s.startedAt)}</td>
                    <td className="px-4 py-2.5">{s.orgName ?? '—'}</td>
                    <td className="px-4 py-2.5">{s.userEmail ?? '—'}</td>
                    <td className="max-w-[220px] truncate px-4 py-2.5">{s.title || 'Untitled'}</td>
                    <td className="px-4 py-2.5 text-right">{s.turnCount}</td>
                    <td className="px-4 py-2.5 text-right">{formatCost(s.totalCostCents)}</td>
                    <td className="px-4 py-2.5">
                      {s.flaggedAt ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
                          title={s.flagReason || 'Flagged'}
                        >
                          <Flag className="h-3 w-3" /> Flagged
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                      No client AI sessions match the filters
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {/* Pagination */}
        {!loading && !loadError && total > 0 && (
          <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
            <span>
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                disabled={offset === 0}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-50"
                data-testid="ai-office-sessions-prev"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </button>
              <button
                type="button"
                onClick={() => setOffset(offset + PAGE_SIZE)}
                disabled={offset + PAGE_SIZE >= total}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-50"
                data-testid="ai-office-sessions-next"
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Transcript drawer */}
      {detailId && (
        <Dialog
          open
          onClose={closeDetail}
          title="Session transcript"
          maxWidth="4xl"
          alignTop
          className="flex max-h-[90vh] flex-col p-6"
        >
          {detailLoading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          )}
          {!detailLoading && !detail && (
            <p className="text-sm text-muted-foreground" data-testid="ai-office-session-detail-error">
              Failed to load the session transcript.
            </p>
          )}
          {detail && (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{detail.session.title || 'Untitled session'}</h2>
                  <p className="text-sm text-muted-foreground">
                    {detail.session.orgName ?? '—'} · {detail.session.userEmail ?? '—'} ·{' '}
                    {detail.session.model} · {formatCost(detail.session.totalCostCents)} ·{' '}
                    {detail.session.totalInputTokens} in / {detail.session.totalOutputTokens} out
                  </p>
                  {detail.session.flagReason && (
                    <p className="mt-1 text-sm text-amber-700 dark:text-amber-400" data-testid="ai-office-session-flag-reason">
                      Flag reason: {detail.session.flagReason}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  {detail.session.flaggedAt ? (
                    <button
                      type="button"
                      onClick={() => setUnflagOpen(true)}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-sm hover:bg-muted"
                      data-testid="ai-office-session-unflag"
                    >
                      <FlagOff className="h-4 w-4" /> Unflag
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setFlagOpen(true)}
                      className="inline-flex items-center gap-1 rounded-md border border-amber-500/50 px-2 py-1.5 text-sm text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
                      data-testid="ai-office-session-flag"
                    >
                      <Flag className="h-4 w-4" /> Flag
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-4 flex-1 space-y-4 overflow-y-auto pr-1">
                {/* Messages with redaction badges + workbook-context chips */}
                <div className="space-y-2">
                  {detail.messages.map((m) => {
                    const redactions = Object.entries(m.redactionCounts ?? {});
                    const chips = workbookChips(m);
                    return (
                      <div
                        key={m.id}
                        className={`rounded-md border p-3 ${m.role === 'user' ? 'bg-muted/30' : 'bg-card'}`}
                      >
                        <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-semibold uppercase tracking-wide">{m.role}</span>
                          <span>{formatTime(m.createdAt)}</span>
                          {chips.map((chip) => (
                            <span
                              key={chip}
                              className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-400"
                            >
                              {chip}
                            </span>
                          ))}
                          {redactions.map(([type, count]) => (
                            <span
                              key={type}
                              className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400"
                              data-testid={`ai-office-redaction-${type}`}
                            >
                              redacted: {type} ×{count}
                            </span>
                          ))}
                        </div>
                        {m.content && <p className="whitespace-pre-wrap text-sm">{m.content}</p>}
                      </div>
                    );
                  })}
                  {detail.messages.length === 0 && (
                    <p className="text-sm text-muted-foreground">No messages stored for this session.</p>
                  )}
                </div>

                {/* Tool approval trail */}
                {detail.toolExecutions.length > 0 && (
                  <div>
                    <h4 className="mb-2 text-sm font-semibold">Tool approval trail</h4>
                    <div className="space-y-2">
                      {detail.toolExecutions.map((t) => (
                        <div key={t.id} className="rounded-md border p-3 text-sm" data-testid={`ai-office-tool-exec-${t.id}`}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs">{t.toolName}</span>
                            <ToolStatusBadge status={t.status} />
                            {typeof (t.toolInput as { range?: unknown } | null)?.range === 'string' && (
                              <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                                {(t.toolInput as { range: string }).range}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            requested {formatTime(t.createdAt)}
                            {t.approvedAt && ` · approved ${formatTime(t.approvedAt)}`}
                            {t.completedAt &&
                              ` · ${t.status === 'rejected' ? 'rejected' : 'applied'} ${formatTime(t.completedAt)}`}
                            {t.durationMs != null && ` · ${t.durationMs}ms`}
                          </p>
                          {t.errorMessage && (
                            <p className="mt-1 text-xs text-destructive">{t.errorMessage}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </Dialog>
      )}

      {/* Flag dialog (reason prompt) */}
      <Dialog open={flagOpen} onClose={() => setFlagOpen(false)} title="Flag session" maxWidth="md" className="p-6">
        <h3 className="text-lg font-semibold">Flag session</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Flagging marks the session for follow-up and is recorded in the audit log.
        </p>
        <label className="mt-3 block text-sm">
          <span className="text-muted-foreground">Reason (optional)</span>
          <textarea
            value={flagReason}
            onChange={(e) => setFlagReason(e.target.value)}
            rows={3}
            maxLength={1000}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            data-testid="ai-office-flag-reason"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setFlagOpen(false)}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void flagSession()}
            disabled={mutating}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            data-testid="ai-office-flag-confirm"
          >
            {mutating ? 'Flagging…' : 'Flag session'}
          </button>
        </div>
      </Dialog>

      {/* Unflag confirm */}
      <ConfirmDialog
        open={unflagOpen}
        onClose={() => setUnflagOpen(false)}
        onConfirm={() => void unflagSession()}
        title="Unflag session"
        message="Remove the flag from this session? The flag/unflag history stays in the audit log."
        confirmLabel="Unflag"
        variant="warning"
        isLoading={mutating}
        confirmTestId="ai-office-unflag-confirm"
      />
    </div>
  );
}
```

- [ ] **Step 2: Write the component tests**

`apps/web/src/components/clientAi/SessionsTab.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SessionsTab from './SessionsTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const SESSION_ID = '5e5e5e5e-1111-4222-8333-444455556666';

const LIST_ROW = {
  id: SESSION_ID,
  orgId: ORG_ID,
  orgName: 'Contoso Accounting',
  clientUserId: 'beefbeef-1111-4222-8333-444455556666',
  userEmail: 'finance.user@contoso.com',
  title: 'Q3 budget review',
  startedAt: '2026-06-10T09:00:00Z',
  lastActivityAt: '2026-06-10T09:20:00Z',
  turnCount: 6,
  totalCostCents: 12.5,
  flaggedAt: null,
  flagReason: null,
  status: 'closed',
};

const DETAIL = {
  session: {
    ...LIST_ROW,
    model: 'claude-sonnet-4-5-20250929',
    totalInputTokens: 4000,
    totalOutputTokens: 900,
    flaggedBy: null,
    createdAt: '2026-06-10T09:00:00Z',
  },
  messages: [
    {
      id: 'm1',
      role: 'user',
      content: 'Card [REDACTED:creditCard] please summarize',
      contentBlocks: null,
      toolName: null,
      toolInput: null,
      toolOutput: null,
      createdAt: '2026-06-10T09:00:01Z',
      redactionCounts: { creditCard: 1 },
    },
  ],
  toolExecutions: [
    {
      id: 't1',
      toolName: 'write_range',
      toolInput: { range: 'B2:B4' },
      status: 'completed',
      approvedBy: null,
      approvedAt: '2026-06-10T09:05:00Z',
      errorMessage: null,
      durationMs: 240,
      createdAt: '2026-06-10T09:04:00Z',
      completedAt: '2026-06-10T09:05:01Z',
    },
  ],
};

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

function mockApi() {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/client-ai/admin/orgs' && !init?.method) {
      return makeJsonResponse({
        data: [{ orgId: ORG_ID, orgName: 'Contoso Accounting' }],
      });
    }
    if (url.startsWith('/client-ai/admin/sessions?') && !init?.method) {
      return makeJsonResponse({
        data: [LIST_ROW],
        pagination: { total: 1, limit: 50, offset: 0 },
      });
    }
    if (url === `/client-ai/admin/sessions/${SESSION_ID}` && !init?.method) {
      return makeJsonResponse(DETAIL);
    }
    if (url === `/client-ai/admin/sessions/${SESSION_ID}/flag` && init?.method === 'POST') {
      return makeJsonResponse({ success: true });
    }
    if (url === `/client-ai/admin/sessions/${SESSION_ID}/flag` && init?.method === 'DELETE') {
      return makeJsonResponse({ success: true });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 500);
  });
}

describe('SessionsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists sessions and shows the transcript with redaction badges + tool trail', async () => {
    mockApi();
    render(<SessionsTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-session-row-${SESSION_ID}`)).toBeInTheDocument()
    );
    expect(screen.getByText('finance.user@contoso.com')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`ai-office-session-row-${SESSION_ID}`));
    await waitFor(() =>
      expect(screen.getByTestId('ai-office-redaction-creditCard')).toBeInTheDocument()
    );
    expect(screen.getByTestId('ai-office-redaction-creditCard').textContent).toContain('×1');
    expect(screen.getByTestId('ai-office-tool-exec-t1')).toBeInTheDocument();
    expect(screen.getByText('B2:B4')).toBeInTheDocument();
  });

  it('flags a session with a reason (exact POST payload)', async () => {
    mockApi();
    render(<SessionsTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-session-row-${SESSION_ID}`)).toBeInTheDocument()
    );

    fireEvent.click(screen.getByTestId(`ai-office-session-row-${SESSION_ID}`));
    await waitFor(() => expect(screen.getByTestId('ai-office-session-flag')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-office-session-flag'));
    fireEvent.change(screen.getByTestId('ai-office-flag-reason'), {
      target: { value: 'PII concern' },
    });
    fireEvent.click(screen.getByTestId('ai-office-flag-confirm'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    );
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(String(postCall![0])).toBe(`/client-ai/admin/sessions/${SESSION_ID}/flag`);
    expect(JSON.parse(String(postCall![1]!.body))).toEqual({ reason: 'PII concern' });
  });

  it('unflags a flagged session through the confirm dialog', async () => {
    // Same mock surface as mockApi(), but the session is flagged so the
    // Unflag button renders.
    const flaggedDetail = {
      ...DETAIL,
      session: { ...DETAIL.session, flaggedAt: '2026-06-11T00:00:00Z', flagReason: 'old' },
    };
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/client-ai/admin/orgs' && !init?.method)
        return makeJsonResponse({ data: [{ orgId: ORG_ID, orgName: 'Contoso Accounting' }] });
      if (url.startsWith('/client-ai/admin/sessions?') && !init?.method)
        return makeJsonResponse({
          data: [{ ...LIST_ROW, flaggedAt: '2026-06-11T00:00:00Z', flagReason: 'old' }],
          pagination: { total: 1, limit: 50, offset: 0 },
        });
      if (url === `/client-ai/admin/sessions/${SESSION_ID}` && !init?.method)
        return makeJsonResponse(flaggedDetail);
      if (url === `/client-ai/admin/sessions/${SESSION_ID}/flag` && init?.method === 'DELETE')
        return makeJsonResponse({ success: true });
      return makeJsonResponse({ error: 'unexpected' }, false, 500);
    });

    render(<SessionsTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-session-row-${SESSION_ID}`)).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId(`ai-office-session-row-${SESSION_ID}`));
    await waitFor(() => expect(screen.getByTestId('ai-office-session-unflag')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-office-session-unflag'));
    fireEvent.click(screen.getByTestId('ai-office-unflag-confirm'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
    );
  });

  it('flagged-only filter adds flagged=true to the list query', async () => {
    mockApi();
    render(<SessionsTab />);
    await waitFor(() =>
      expect(screen.getByTestId('ai-office-sessions-flagged')).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId('ai-office-sessions-flagged'));
    await waitFor(() => {
      const listCalls = fetchMock.mock.calls.filter(([u]) =>
        String(u).startsWith('/client-ai/admin/sessions?')
      );
      expect(String(listCalls[listCalls.length - 1]![0])).toContain('flagged=true');
    });
  });
});
```

- [ ] **Step 3: Adopt into the WS-A guard**

Append to `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`:

```ts
  'src/components/clientAi/SessionsTab.tsx',
```

- [ ] **Step 4: Run the tests**

```bash
cd /Users/toddhebebrand/breeze/apps/web
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/components/clientAi/SessionsTab.test.tsx src/lib/__tests__/no-silent-mutations.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/clientAi/SessionsTab.tsx apps/web/src/components/clientAi/SessionsTab.test.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(client-ai-web): session audit viewer with transcript drawer + flag/unflag" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: UsageTab — per-org/per-user usage report + CSV export

Spec §8/§9.4. Consumes Task 4's `GET /client-ai/admin/usage?from&to[&orgId]` (`{rows, totals}`) and `GET /client-ai/admin/usage.csv`. Native `<input type="month">` produces exactly the `YYYY-MM` strings `adminUsageQuerySchema` requires. The CSV download is the **`BillablesExportCard.tsx:30-55` blob pattern verbatim** (fetchWithAuth → blob → `URL.createObjectURL` → synthetic `<a download>` click → revoke) — a GET, so no `runAction`, with explicit error toasts like the precedent. Table groups rows per org with expandable per-user rows and a totals footer.

**Files:**
- Create: apps/web/src/components/clientAi/UsageTab.tsx
- Create: apps/web/src/components/clientAi/UsageTab.test.tsx

- [ ] **Step 1: Write the component**

`apps/web/src/components/clientAi/UsageTab.tsx`:

```tsx
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';

/**
 * AI for Office — usage & billing report (spec §8, §9.4). The CSV is the MSP's
 * resale-invoicing artifact (Plan-4 Task 4 pins its column order server-side).
 * GET-only component: list + CSV export, no mutations — deliberately NOT in
 * the no-silent-mutations TARGET_GLOBS.
 */

/** Row/totals shapes of GET /client-ai/admin/usage (Plan-4 Task 4). */
interface UsageRow {
  month: string;
  orgId: string;
  orgName: string | null;
  clientUserId: string | null;
  userEmail: string | null;
  messageCount: number;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

interface UsageTotals {
  messageCount: number;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

const formatCost = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const formatTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);

interface OrgGroup {
  orgId: string;
  orgName: string | null;
  rows: UsageRow[];
  subtotal: UsageTotals;
}

export default function UsageTab() {
  const [from, setFrom] = useState(currentMonthKey());
  const [to, setTo] = useState(currentMonthKey());
  const [orgFilter, setOrgFilter] = useState('');
  const [orgs, setOrgs] = useState<{ orgId: string; orgName: string }[]>([]);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [totals, setTotals] = useState<UsageTotals | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [expandedOrgs, setExpandedOrgs] = useState<Set<string>>(new Set());

  const rangeValid = from !== '' && to !== '' && from <= to;

  useEffect(() => {
    void fetchWithAuth('/client-ai/admin/orgs')
      .then((r) => (r.ok ? (r.json() as Promise<{ data?: { orgId: string; orgName: string }[] }>) : null))
      .then((b) => {
        if (b?.data) setOrgs(b.data.map(({ orgId, orgName }) => ({ orgId, orgName })));
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!rangeValid) return;
    try {
      setLoading(true);
      setLoadError(false);
      const qs = new URLSearchParams({ from, to });
      if (orgFilter) qs.set('orgId', orgFilter);
      const res = await fetchWithAuth(`/client-ai/admin/usage?${qs.toString()}`);
      if (res.status === 401) {
        void navigateTo('/login', { replace: true });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { rows: UsageRow[]; totals: UsageTotals };
      setRows(body.rows ?? []);
      setTotals(body.totals ?? null);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [from, to, orgFilter, rangeValid]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo<OrgGroup[]>(() => {
    const byOrg = new Map<string, OrgGroup>();
    for (const r of rows) {
      let g = byOrg.get(r.orgId);
      if (!g) {
        g = {
          orgId: r.orgId,
          orgName: r.orgName,
          rows: [],
          subtotal: { messageCount: 0, sessionCount: 0, inputTokens: 0, outputTokens: 0, costCents: 0 },
        };
        byOrg.set(r.orgId, g);
      }
      g.rows.push(r);
      g.subtotal.messageCount += r.messageCount;
      g.subtotal.sessionCount += r.sessionCount;
      g.subtotal.inputTokens += r.inputTokens;
      g.subtotal.outputTokens += r.outputTokens;
      g.subtotal.costCents = Math.round((g.subtotal.costCents + r.costCents) * 100) / 100;
    }
    return [...byOrg.values()];
  }, [rows]);

  const toggleOrg = (orgId: string) =>
    setExpandedOrgs((prev) => {
      const next = new Set(prev);
      if (next.has(orgId)) {
        next.delete(orgId);
      } else {
        next.add(orgId);
      }
      return next;
    });

  // CSV export — the BillablesExportCard.tsx blob-download pattern. The
  // filename matches the route's Content-Disposition (Plan-4 Task 4).
  const downloadCsv = async () => {
    if (downloading || !rangeValid) return;
    setDownloading(true);
    try {
      const qs = new URLSearchParams({ from, to });
      if (orgFilter) qs.set('orgId', orgFilter);
      const res = await fetchWithAuth(`/client-ai/admin/usage.csv?${qs.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        showToast({
          type: 'error',
          message: (body as { error?: string } | null)?.error ?? 'Export failed',
        });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `client-ai-usage-${from}-to-${to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      showToast({ type: 'error', message: 'Export failed' });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Range + filter bar */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">
          From month
          <input
            type="month"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm"
            data-testid="ai-office-usage-from"
          />
        </label>
        <label className="text-xs">
          To month
          <input
            type="month"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm"
            data-testid="ai-office-usage-to"
          />
        </label>
        <label className="text-xs">
          Organization
          <select
            value={orgFilter}
            onChange={(e) => setOrgFilter(e.target.value)}
            className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm"
            data-testid="ai-office-usage-org"
          >
            <option value="">All organizations</option>
            {orgs.map((o) => (
              <option key={o.orgId} value={o.orgId}>
                {o.orgName}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void downloadCsv()}
          disabled={downloading || !rangeValid}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          data-testid="ai-office-usage-export"
        >
          <Download className="h-4 w-4" />
          {downloading ? 'Exporting…' : 'Export CSV'}
        </button>
        {!rangeValid && (
          <span className="pb-1.5 text-xs text-destructive">From month must be ≤ to month</span>
        )}
      </div>

      {/* Report table */}
      <div className="rounded-lg border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <div className="p-6 text-sm text-muted-foreground" data-testid="ai-office-usage-load-error">
            Failed to load the usage report.{' '}
            <button type="button" className="text-primary underline" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2">Organization / user</th>
                  <th className="px-4 py-2">Month</th>
                  <th className="px-4 py-2 text-right">Messages</th>
                  <th className="px-4 py-2 text-right">Sessions</th>
                  <th className="px-4 py-2 text-right">Tokens (in/out)</th>
                  <th className="px-4 py-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const expanded = expandedOrgs.has(g.orgId);
                  return (
                    <Fragment key={g.orgId}>
                      <tr
                        onClick={() => toggleOrg(g.orgId)}
                        className="cursor-pointer border-b font-medium hover:bg-muted/20"
                        data-testid={`ai-office-usage-org-${g.orgId}`}
                      >
                        <td className="px-4 py-2.5">
                          <span className="inline-flex items-center gap-1.5">
                            {expanded ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )}
                            {g.orgName ?? g.orgId}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">
                          {g.rows.length} row{g.rows.length === 1 ? '' : 's'}
                        </td>
                        <td className="px-4 py-2.5 text-right">{g.subtotal.messageCount}</td>
                        <td className="px-4 py-2.5 text-right">{g.subtotal.sessionCount}</td>
                        <td className="px-4 py-2.5 text-right">
                          {formatTokens(g.subtotal.inputTokens)} / {formatTokens(g.subtotal.outputTokens)}
                        </td>
                        <td className="px-4 py-2.5 text-right">{formatCost(g.subtotal.costCents)}</td>
                      </tr>
                      {expanded &&
                        g.rows.map((r) => (
                          <tr
                            key={`${r.orgId}-${r.clientUserId}-${r.month}`}
                            className="border-b bg-muted/10 last:border-0"
                            data-testid="ai-office-usage-user-row"
                          >
                            <td className="px-4 py-2 pl-12 text-muted-foreground">
                              {r.userEmail ?? r.clientUserId ?? '—'}
                            </td>
                            <td className="px-4 py-2 text-xs text-muted-foreground">{r.month}</td>
                            <td className="px-4 py-2 text-right">{r.messageCount}</td>
                            <td className="px-4 py-2 text-right">{r.sessionCount}</td>
                            <td className="px-4 py-2 text-right">
                              {formatTokens(r.inputTokens)} / {formatTokens(r.outputTokens)}
                            </td>
                            <td className="px-4 py-2 text-right">{formatCost(r.costCents)}</td>
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
                {groups.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      No usage recorded in this range
                    </td>
                  </tr>
                )}
              </tbody>
              {totals && groups.length > 0 && (
                <tfoot>
                  <tr className="border-t bg-muted/30 font-semibold" data-testid="ai-office-usage-totals">
                    <td className="px-4 py-2.5" colSpan={2}>
                      Total
                    </td>
                    <td className="px-4 py-2.5 text-right">{totals.messageCount}</td>
                    <td className="px-4 py-2.5 text-right">{totals.sessionCount}</td>
                    <td className="px-4 py-2.5 text-right">
                      {formatTokens(totals.inputTokens)} / {formatTokens(totals.outputTokens)}
                    </td>
                    <td className="px-4 py-2.5 text-right">{formatCost(totals.costCents)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the component tests**

`apps/web/src/components/clientAi/UsageTab.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UsageTab from './UsageTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';

const USAGE_ROWS = [
  {
    month: '2026-06',
    orgId: ORG_ID,
    orgName: 'Contoso Accounting',
    clientUserId: 'beefbeef-1111-4222-8333-444455556666',
    userEmail: 'finance.user@contoso.com',
    messageCount: 40,
    sessionCount: 4,
    inputTokens: 10000,
    outputTokens: 2000,
    costCents: 150,
  },
  {
    month: '2026-06',
    orgId: ORG_ID,
    orgName: 'Contoso Accounting',
    clientUserId: 'cafecafe-1111-4222-8333-444455556666',
    userEmail: 'ap.clerk@contoso.com',
    messageCount: 18,
    sessionCount: 2,
    inputTokens: 5000,
    outputTokens: 1000,
    costCents: 75,
  },
];

const TOTALS = {
  messageCount: 58,
  sessionCount: 6,
  inputTokens: 15000,
  outputTokens: 3000,
  costCents: 225,
};

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

function mockApi() {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/client-ai/admin/orgs' && !init?.method) {
      return makeJsonResponse({ data: [{ orgId: ORG_ID, orgName: 'Contoso Accounting' }] });
    }
    if (url.startsWith('/client-ai/admin/usage.csv?') && !init?.method) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        blob: vi.fn().mockResolvedValue(new Blob(['month,org_name'], { type: 'text/csv' })),
        json: vi.fn(),
      } as unknown as Response;
    }
    if (url.startsWith('/client-ai/admin/usage?') && !init?.method) {
      return makeJsonResponse({ rows: USAGE_ROWS, totals: TOTALS });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 500);
  });
}

describe('UsageTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom has no createObjectURL — stub the pair the download path uses.
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn();
  });

  it('renders org groups with subtotals and the totals footer', async () => {
    mockApi();
    render(<UsageTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-usage-org-${ORG_ID}`)).toBeInTheDocument()
    );
    // Org subtotal row: 58 messages, $2.25 total cost (225 cents)
    expect(screen.getByTestId(`ai-office-usage-org-${ORG_ID}`).textContent).toContain('58');
    expect(screen.getByTestId('ai-office-usage-totals').textContent).toContain('$2.25');
  });

  it('expands an org group to per-user rows', async () => {
    mockApi();
    render(<UsageTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-usage-org-${ORG_ID}`)).toBeInTheDocument()
    );
    expect(screen.queryAllByTestId('ai-office-usage-user-row')).toHaveLength(0);
    fireEvent.click(screen.getByTestId(`ai-office-usage-org-${ORG_ID}`));
    expect(screen.getAllByTestId('ai-office-usage-user-row')).toHaveLength(2);
    expect(screen.getByText('finance.user@contoso.com')).toBeInTheDocument();
    expect(screen.getByText('ap.clerk@contoso.com')).toBeInTheDocument();
  });

  it('re-queries when the month range changes (YYYY-MM params)', async () => {
    mockApi();
    render(<UsageTab />);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/client-ai/admin/usage?'))).toBe(true)
    );
    fireEvent.change(screen.getByTestId('ai-office-usage-from'), { target: { value: '2026-01' } });
    await waitFor(() => {
      const usageCalls = fetchMock.mock.calls.filter(([u]) =>
        String(u).startsWith('/client-ai/admin/usage?')
      );
      expect(String(usageCalls[usageCalls.length - 1]![0])).toContain('from=2026-01');
    });
  });

  it('Export CSV hits usage.csv and triggers a blob download', async () => {
    mockApi();
    render(<UsageTab />);
    await waitFor(() =>
      expect(screen.getByTestId('ai-office-usage-export')).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId('ai-office-usage-export'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).startsWith('/client-ai/admin/usage.csv?'))
      ).toBe(true)
    );
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });
});
```

- [ ] **Step 3: Run the tests**

```bash
cd /Users/toddhebebrand/breeze/apps/web
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/components/clientAi/UsageTab.test.tsx
```

Expected: 4 tests PASS. (UsageTab has no mutating fetches — CSV export is a GET — so it is intentionally not added to `TARGET_GLOBS`.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/clientAi/UsageTab.tsx apps/web/src/components/clientAi/UsageTab.test.tsx
git commit -m "feat(client-ai-web): usage report with per-user drill-down + CSV export" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: TemplatesTab — prompt template CRUD

Spec §9.5/§10. Consumes Task 5's endpoints exactly: `GET /client-ai/admin/templates` → `{data}`, `POST /templates` (`templateBodySchema`: `orgId: null` ⇒ partner-wide/all-orgs row) → `201 {template}`, `PUT /templates/:id` (`templateUpdateSchema` — **no orgId key**; scope is immutable after create), `DELETE /templates/:id` → `{success:true}`. A 403 `partner_scope_required` on an all-orgs create from org scope surfaces via runAction's error toast.

**Files:**
- Create: apps/web/src/components/clientAi/TemplatesTab.tsx
- Create: apps/web/src/components/clientAi/TemplatesTab.test.tsx
- Modify: apps/web/src/lib/__tests__/no-silent-mutations.test.ts (`TARGET_GLOBS`)

- [ ] **Step 1: Write the component**

`apps/web/src/components/clientAi/TemplatesTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { Dialog } from '../shared/Dialog';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { runAction, handleActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';

/**
 * AI for Office — prompt template manager (spec §9.5, §10). Templates surface
 * in the add-in's empty-chat picker (Plan-4 Task 6 client route). Scope:
 * orgId NULL = partner-wide ("All orgs") row, else org-scoped. Scope is
 * immutable after create (templateUpdateSchema has no orgId — Plan-4 Task 5;
 * move a template by delete + recreate).
 */

/** Row shape of GET /client-ai/admin/templates (Plan-4 Task 5). */
interface TemplateRow {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  orgName: string | null;
  name: string;
  description: string | null;
  promptBody: string;
  category: string | null;
  createdAt: string;
  updatedAt: string;
}

type EditorState = { mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; template: TemplateRow };

function ScopeBadge({ row }: { row: TemplateRow }) {
  if (row.orgId === null) {
    return (
      <span
        className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-400"
        data-testid="ai-office-template-scope-partner"
      >
        All orgs
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600 dark:border-slate-500/30 dark:bg-slate-500/10 dark:text-slate-400"
      data-testid="ai-office-template-scope-org"
    >
      {row.orgName ?? 'Org'}
    </span>
  );
}

export default function TemplatesTab() {
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [orgs, setOrgs] = useState<{ orgId: string; orgName: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' });
  const [deleting, setDeleting] = useState<TemplateRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoadError(false);
      const res = await fetchWithAuth('/client-ai/admin/templates');
      if (res.status === 401) {
        void navigateTo('/login', { replace: true });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data: TemplateRow[] };
      setRows(body.data ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Org options for the create-dialog scope selector.
  useEffect(() => {
    void fetchWithAuth('/client-ai/admin/orgs')
      .then((r) => (r.ok ? (r.json() as Promise<{ data?: { orgId: string; orgName: string }[] }>) : null))
      .then((b) => {
        if (b?.data) setOrgs(b.data.map(({ orgId, orgName }) => ({ orgId, orgName })));
      })
      .catch(() => {});
  }, []);

  const confirmDelete = async () => {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/client-ai/admin/templates/${deleting.id}`, { method: 'DELETE' }),
        errorFallback: 'Failed to delete template',
        successMessage: `Template "${deleting.name}" deleted`,
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      setDeleting(null);
      await load();
    } catch (err) {
      handleActionError(err, 'Failed to delete template');
    } finally {
      setDeleteBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div
        className="rounded-lg border bg-card p-6 text-sm text-muted-foreground"
        data-testid="ai-office-templates-load-error"
      >
        Failed to load templates.{' '}
        <button
          type="button"
          className="text-primary underline"
          onClick={() => {
            setLoading(true);
            void load();
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">Prompt templates</h2>
            <p className="text-sm text-muted-foreground">
              Shown in the add-in&apos;s empty-chat picker. &quot;All orgs&quot; templates reach
              every client org; org templates only theirs.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEditor({ mode: 'create' })}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
            data-testid="ai-office-template-create"
          >
            <Plus className="h-4 w-4" /> New template
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Scope</th>
                <th className="px-4 py-2">Category</th>
                <th className="px-4 py-2">Updated</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b last:border-0 hover:bg-muted/20"
                  data-testid={`ai-office-template-row-${row.id}`}
                >
                  <td className="px-4 py-2.5">
                    <p className="font-medium">{row.name}</p>
                    {row.description && (
                      <p className="max-w-[360px] truncate text-xs text-muted-foreground">{row.description}</p>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <ScopeBadge row={row} />
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{row.category ?? '—'}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {new Date(row.updatedAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditor({ mode: 'edit', template: row })}
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                        data-testid={`ai-office-template-edit-${row.id}`}
                      >
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleting(row)}
                        className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                        data-testid={`ai-office-template-delete-${row.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    No templates yet — create the first one
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editor.mode !== 'closed' && (
        <TemplateEditorDialog
          state={editor}
          orgs={orgs}
          onClose={() => setEditor({ mode: 'closed' })}
          onSaved={() => {
            setEditor({ mode: 'closed' });
            void load();
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
        title="Delete template"
        message={
          deleting
            ? `Delete "${deleting.name}"? It disappears from the add-in's template picker immediately.`
            : ''
        }
        confirmLabel="Delete"
        isLoading={deleteBusy}
        confirmTestId="ai-office-template-delete-confirm"
      />
    </div>
  );
}

// ── Create/edit dialog ────────────────────────────────────────────────────────

function TemplateEditorDialog({
  state,
  orgs,
  onClose,
  onSaved,
}: {
  state: Exclude<EditorState, { mode: 'closed' }>;
  orgs: { orgId: string; orgName: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = state.mode === 'edit' ? state.template : null;
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [category, setCategory] = useState(editing?.category ?? '');
  const [body, setBody] = useState(editing?.promptBody ?? '');
  // 'partner' or an orgId. Immutable in edit mode (templateUpdateSchema has no
  // orgId — Plan-4 Task 5).
  const [scope, setScope] = useState<string>(editing ? (editing.orgId ?? 'partner') : 'partner');
  const [saving, setSaving] = useState(false);

  const valid = name.trim().length > 0 && body.trim().length > 0;

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      if (editing) {
        // templateUpdateSchema: name/description/promptBody/category only.
        await runAction({
          request: () =>
            fetchWithAuth(`/client-ai/admin/templates/${editing.id}`, {
              method: 'PUT',
              body: JSON.stringify({
                name: name.trim(),
                description: description.trim() ? description.trim() : null,
                promptBody: body,
                category: category.trim() ? category.trim() : null,
              }),
            }),
          errorFallback: 'Failed to update template',
          successMessage: 'Template updated',
          onUnauthorized: () => void navigateTo('/login', { replace: true }),
        });
      } else {
        // templateBodySchema: orgId null ⇒ partner-wide row. A 403
        // partner_scope_required (org-scope caller) surfaces via the toast.
        await runAction({
          request: () =>
            fetchWithAuth('/client-ai/admin/templates', {
              method: 'POST',
              body: JSON.stringify({
                name: name.trim(),
                description: description.trim() ? description.trim() : null,
                promptBody: body,
                category: category.trim() ? category.trim() : null,
                orgId: scope === 'partner' ? null : scope,
              }),
            }),
          errorFallback: 'Failed to create template',
          successMessage: 'Template created',
          onUnauthorized: () => void navigateTo('/login', { replace: true }),
        });
      }
      onSaved();
    } catch (err) {
      handleActionError(err, editing ? 'Failed to update template' : 'Failed to create template');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? 'Edit template' : 'New template'}
      maxWidth="3xl"
      className="p-6"
    >
      <h2 className="text-lg font-semibold">{editing ? 'Edit template' : 'New template'}</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-muted-foreground">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            data-testid="ai-office-template-name"
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">Category</span>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            maxLength={100}
            placeholder="e.g. finance"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            data-testid="ai-office-template-category"
          />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="text-muted-foreground">Description</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            data-testid="ai-office-template-description"
          />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="text-muted-foreground">Prompt body</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            maxLength={20000}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
            data-testid="ai-office-template-body"
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">Scope</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            disabled={editing !== null}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60"
            data-testid="ai-office-template-scope"
          >
            <option value="partner">All organizations (partner-wide)</option>
            {orgs.map((o) => (
              <option key={o.orgId} value={o.orgId}>
                {o.orgName}
              </option>
            ))}
          </select>
          {editing !== null && (
            <span className="mt-1 block text-xs text-muted-foreground">
              Scope can&apos;t change after creation — delete and recreate to move it.
            </span>
          )}
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!valid || saving}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          data-testid="ai-office-template-save"
        >
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Create template'}
        </button>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 2: Write the component tests**

`apps/web/src/components/clientAi/TemplatesTab.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TemplatesTab from './TemplatesTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const PARTNER_ID = 'f0f0f0f0-1111-4222-8333-444455556666';
const TEMPLATE_ID = '7e7e7e7e-1111-4222-8333-444455556666';
const ORG_TEMPLATE_ID = '8f8f8f8f-1111-4222-8333-444455556666';

const PARTNER_ROW = {
  id: TEMPLATE_ID,
  orgId: null,
  partnerId: PARTNER_ID,
  orgName: null,
  name: 'Quarterly variance walkthrough',
  description: 'Explains variance between columns',
  promptBody: 'Explain the variance between the selected columns.',
  category: 'finance',
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

const ORG_ROW = {
  ...PARTNER_ROW,
  id: ORG_TEMPLATE_ID,
  orgId: ORG_ID,
  partnerId: null,
  orgName: 'Contoso Accounting',
  name: 'Contoso month-end checklist',
};

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

function mockApi() {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/client-ai/admin/templates' && !init?.method) {
      return makeJsonResponse({ data: [PARTNER_ROW, ORG_ROW] });
    }
    if (url === '/client-ai/admin/templates' && init?.method === 'POST') {
      return makeJsonResponse({ template: { ...PARTNER_ROW, id: 'new-id' } }, true, 201);
    }
    if (url === `/client-ai/admin/templates/${TEMPLATE_ID}` && init?.method === 'PUT') {
      return makeJsonResponse({ template: { ...PARTNER_ROW, name: 'Renamed' } });
    }
    if (url === `/client-ai/admin/templates/${TEMPLATE_ID}` && init?.method === 'DELETE') {
      return makeJsonResponse({ success: true });
    }
    if (url === '/client-ai/admin/orgs' && !init?.method) {
      return makeJsonResponse({ data: [{ orgId: ORG_ID, orgName: 'Contoso Accounting' }] });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 500);
  });
}

describe('TemplatesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders scope badges: All orgs for partner-wide, org name for org-scoped', async () => {
    mockApi();
    render(<TemplatesTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-template-row-${TEMPLATE_ID}`)).toBeInTheDocument()
    );
    expect(screen.getByTestId('ai-office-template-scope-partner').textContent).toBe('All orgs');
    expect(screen.getByTestId('ai-office-template-scope-org').textContent).toBe('Contoso Accounting');
  });

  it('creates a partner-wide template (exact POST payload)', async () => {
    mockApi();
    render(<TemplatesTab />);
    await waitFor(() => expect(screen.getByTestId('ai-office-template-create')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-office-template-create'));
    fireEvent.change(screen.getByTestId('ai-office-template-name'), { target: { value: 'New' } });
    fireEvent.change(screen.getByTestId('ai-office-template-body'), { target: { value: 'Body' } });
    // Scope select defaults to 'partner' — leave it.
    fireEvent.click(screen.getByTestId('ai-office-template-save'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    );
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(String(postCall![0])).toBe('/client-ai/admin/templates');
    expect(JSON.parse(String(postCall![1]!.body))).toEqual({
      name: 'New',
      description: null,
      promptBody: 'Body',
      category: null,
      orgId: null,
    });
  });

  it('creates an org-scoped template when an org is chosen', async () => {
    mockApi();
    render(<TemplatesTab />);
    await waitFor(() => expect(screen.getByTestId('ai-office-template-create')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-office-template-create'));
    fireEvent.change(screen.getByTestId('ai-office-template-name'), { target: { value: 'Org one' } });
    fireEvent.change(screen.getByTestId('ai-office-template-body'), { target: { value: 'Body' } });
    await waitFor(() =>
      expect(
        (screen.getByTestId('ai-office-template-scope') as HTMLSelectElement).options.length
      ).toBeGreaterThan(1)
    );
    fireEvent.change(screen.getByTestId('ai-office-template-scope'), { target: { value: ORG_ID } });
    fireEvent.click(screen.getByTestId('ai-office-template-save'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    );
    const body = JSON.parse(
      String(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body)
    );
    expect(body.orgId).toBe(ORG_ID);
  });

  it('edits without an orgId key (scope is immutable) and the scope select is disabled', async () => {
    mockApi();
    render(<TemplatesTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-template-edit-${TEMPLATE_ID}`)).toBeInTheDocument()
    );

    fireEvent.click(screen.getByTestId(`ai-office-template-edit-${TEMPLATE_ID}`));
    expect((screen.getByTestId('ai-office-template-scope') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('ai-office-template-name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('ai-office-template-save'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    );
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(String(putCall![0])).toBe(`/client-ai/admin/templates/${TEMPLATE_ID}`);
    const body = JSON.parse(String(putCall![1]!.body));
    expect(body).not.toHaveProperty('orgId');
    expect(body.name).toBe('Renamed');
  });

  it('deletes through the confirm dialog', async () => {
    mockApi();
    render(<TemplatesTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-template-delete-${TEMPLATE_ID}`)).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId(`ai-office-template-delete-${TEMPLATE_ID}`));
    fireEvent.click(screen.getByTestId('ai-office-template-delete-confirm'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
    );
    const delCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(String(delCall![0])).toBe(`/client-ai/admin/templates/${TEMPLATE_ID}`);
  });
});
```

- [ ] **Step 3: Adopt into the WS-A guard**

Append to `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`. After this task the full clientAi block reads:

```ts
  'src/components/clientAi/OrgsTab.tsx',
  'src/components/clientAi/PolicyEditor.tsx',
  'src/components/clientAi/SessionsTab.tsx',
  'src/components/clientAi/TemplatesTab.tsx',
```

- [ ] **Step 4: Run the tests**

```bash
cd /Users/toddhebebrand/breeze/apps/web
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/components/clientAi/TemplatesTab.test.tsx src/lib/__tests__/no-silent-mutations.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/clientAi/TemplatesTab.tsx apps/web/src/components/clientAi/TemplatesTab.test.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(client-ai-web): prompt template manager with org/partner scopes" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Page shell — hash-tab island, Astro page, sidebar nav entry

Wires the five tab components built in Tasks 8–12 into one island. Hash routing follows `DeviceDetails.tsx:147-166` (state-from-hash + `hashchange` listener) with the `OrganizationsPage.tsx`-style id-in-hash for `#policy/<orgId>`. The Astro page mirrors `pam.astro` exactly. The nav entry goes into the "AI & Fleet" section of `Sidebar.tsx` behind a new `partnerScopeOnly` flag that mirrors the existing `platformAdminOnly` flag (`Sidebar.tsx:79-89, 421-422`) and the partner-branding fetch's `getJwtClaims().scope` gate (`Sidebar.tsx:306-308`) — client-side UX nicety only; the server re-checks everything.

**Files:**
- Create: apps/web/src/components/clientAi/AiForOfficePage.tsx
- Create: apps/web/src/components/clientAi/AiForOfficePage.test.tsx
- Create: apps/web/src/pages/ai-for-office.astro
- Modify: apps/web/src/components/layout/Sidebar.tsx

- [ ] **Step 1: Write the island shell**

`apps/web/src/components/clientAi/AiForOfficePage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import OrgsTab from './OrgsTab';
import PolicyEditor from './PolicyEditor';
import SessionsTab from './SessionsTab';
import UsageTab from './UsageTab';
import TemplatesTab from './TemplatesTab';

/**
 * AI for Office — MSP admin surface shell (spec §9). Tab state lives in
 * window.location.hash (#orgs default, #sessions, #usage, #templates,
 * #policy/<orgId>) per the DeviceDetails.tsx hash-tab convention — never
 * query params. Deep links and reloads land on the right tab.
 */

const SIMPLE_TABS = ['orgs', 'sessions', 'usage', 'templates'] as const;
type SimpleTab = (typeof SIMPLE_TABS)[number];

export type TabState = { tab: SimpleTab } | { tab: 'policy'; orgId: string };

export function getStateFromHash(): TabState {
  if (typeof window === 'undefined') return { tab: 'orgs' };
  const hash = window.location.hash.replace('#', '');
  if (hash.startsWith('policy/')) {
    const orgId = hash.slice('policy/'.length);
    if (orgId) return { tab: 'policy', orgId };
  }
  if ((SIMPLE_TABS as readonly string[]).includes(hash)) return { tab: hash as SimpleTab };
  return { tab: 'orgs' };
}

const TAB_DEFS: { id: SimpleTab; label: string }[] = [
  { id: 'orgs', label: 'Organizations' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'usage', label: 'Usage' },
  { id: 'templates', label: 'Templates' },
];

export default function AiForOfficePage() {
  const [state, setState] = useState<TabState>(getStateFromHash);

  useEffect(() => {
    const onHashChange = () => setState(getStateFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const switchTab = (tab: SimpleTab) => {
    window.location.hash = tab;
    setState({ tab });
  };

  const openPolicy = (orgId: string) => {
    window.location.hash = `policy/${orgId}`;
    setState({ tab: 'policy', orgId });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">AI for Office</h1>
        <p className="text-muted-foreground">
          Governed AI assistant in your clients&apos; Excel — provisioning, policy, audit, usage
          and templates
        </p>
      </div>

      <div className="border-b">
        <nav className="-mb-px flex gap-4">
          {TAB_DEFS.map((t) => {
            const active = state.tab === t.id || (t.id === 'orgs' && state.tab === 'policy');
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => switchTab(t.id)}
                className={`border-b-2 px-1 pb-2 text-sm font-medium transition-colors ${
                  active
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
                data-testid={`ai-office-tab-${t.id}`}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
      </div>

      {state.tab === 'orgs' && <OrgsTab onOpenPolicy={openPolicy} />}
      {state.tab === 'policy' && (
        <PolicyEditor orgId={state.orgId} onBack={() => switchTab('orgs')} />
      )}
      {state.tab === 'sessions' && <SessionsTab />}
      {state.tab === 'usage' && <UsageTab />}
      {state.tab === 'templates' && <TemplatesTab />}
    </div>
  );
}
```

- [ ] **Step 2: Create the Astro page**

`apps/web/src/pages/ai-for-office.astro` (mirrors `pam.astro`):

```astro
---
import DashboardLayout from '../layouts/DashboardLayout.astro';
import AiForOfficePage from '../components/clientAi/AiForOfficePage';
---

<DashboardLayout title="AI for Office">
  <AiForOfficePage client:load />
</DashboardLayout>
```

- [ ] **Step 3: Register the nav entry in Sidebar.tsx**

Three small edits to `apps/web/src/components/layout/Sidebar.tsx`:

**(a)** Add `FileSpreadsheet` to the lucide-react import block (alphabetically near `FileCode`/`FileText`):

```ts
  FileSpreadsheet,
```

**(b)** Extend the `NavItem` type (after the existing `platformAdminOnly` member, ~line 88):

```ts
  // Hidden when the JWT decodes to a non-partner scope (AI for Office is an
  // MSP-admin surface). Client-side UX nicety only — same rationale as the
  // partner-branding fetch below; undecodable tokens fall through to visible
  // and the server re-checks everything.
  partnerScopeOnly?: boolean;
```

**(c)** Add the item to the `ai-fleet` section's `items` (after `AI Workspace`, ~line 119):

```ts
      { name: 'AI for Office', href: '/ai-for-office', icon: FileSpreadsheet, partnerScopeOnly: true },
```

**(d)** Gate it in `renderNavItem`. Directly below the existing `platformAdminOnly` guard (`if (item.platformAdminOnly && !isPlatformAdmin) return null;`, ~line 422) add:

```ts
    if (item.partnerScopeOnly) {
      const { scope } = getJwtClaims();
      if (scope !== null && scope !== 'partner') return null;
    }
```

(`getJwtClaims` is already imported in Sidebar.tsx from `../../lib/authScope` — no new import needed.)

- [ ] **Step 4: Write the shell tests**

`apps/web/src/components/clientAi/AiForOfficePage.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the five tab islands — each has its own test file; here we only test
// the hash routing shell.
vi.mock('./OrgsTab', () => ({
  default: ({ onOpenPolicy }: { onOpenPolicy: (id: string) => void }) => (
    <button data-testid="stub-orgs" onClick={() => onOpenPolicy('ORG-1')}>
      orgs
    </button>
  ),
}));
vi.mock('./PolicyEditor', () => ({
  default: ({ orgId, onBack }: { orgId: string; onBack: () => void }) => (
    <div data-testid="stub-policy">
      <span data-testid="stub-policy-org">{orgId}</span>
      <button data-testid="stub-policy-back" onClick={onBack}>
        back
      </button>
    </div>
  ),
}));
vi.mock('./SessionsTab', () => ({ default: () => <div data-testid="stub-sessions" /> }));
vi.mock('./UsageTab', () => ({ default: () => <div data-testid="stub-usage" /> }));
vi.mock('./TemplatesTab', () => ({ default: () => <div data-testid="stub-templates" /> }));

import AiForOfficePage, { getStateFromHash } from './AiForOfficePage';

describe('AiForOfficePage', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/ai-for-office');
  });

  it('defaults to the orgs tab', () => {
    render(<AiForOfficePage />);
    expect(screen.getByTestId('stub-orgs')).toBeInTheDocument();
  });

  it('reads the initial tab from the hash', () => {
    window.location.hash = '#sessions';
    render(<AiForOfficePage />);
    expect(screen.getByTestId('stub-sessions')).toBeInTheDocument();
  });

  it('switches tabs on click and writes the hash', () => {
    render(<AiForOfficePage />);
    fireEvent.click(screen.getByTestId('ai-office-tab-usage'));
    expect(screen.getByTestId('stub-usage')).toBeInTheDocument();
    expect(window.location.hash).toBe('#usage');
    fireEvent.click(screen.getByTestId('ai-office-tab-templates'));
    expect(screen.getByTestId('stub-templates')).toBeInTheDocument();
    expect(window.location.hash).toBe('#templates');
  });

  it('routes #policy/<orgId> deep links to the policy editor', () => {
    window.location.hash = '#policy/ORG-9';
    render(<AiForOfficePage />);
    expect(screen.getByTestId('stub-policy-org').textContent).toBe('ORG-9');
  });

  it('OrgsTab → policy editor → back round-trip updates the hash', () => {
    render(<AiForOfficePage />);
    fireEvent.click(screen.getByTestId('stub-orgs')); // calls onOpenPolicy('ORG-1')
    expect(screen.getByTestId('stub-policy-org').textContent).toBe('ORG-1');
    expect(window.location.hash).toBe('#policy/ORG-1');
    fireEvent.click(screen.getByTestId('stub-policy-back'));
    expect(screen.getByTestId('stub-orgs')).toBeInTheDocument();
    expect(window.location.hash).toBe('#orgs');
  });

  it('getStateFromHash falls back to orgs for junk hashes', () => {
    window.location.hash = '#nonsense';
    expect(getStateFromHash()).toEqual({ tab: 'orgs' });
    window.location.hash = '#policy/';
    expect(getStateFromHash()).toEqual({ tab: 'orgs' });
  });
});
```

- [ ] **Step 5: Run the tests**

```bash
cd /Users/toddhebebrand/breeze/apps/web
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/components/clientAi/AiForOfficePage.test.tsx
```

Expected: 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/clientAi/AiForOfficePage.tsx apps/web/src/components/clientAi/AiForOfficePage.test.tsx apps/web/src/pages/ai-for-office.astro apps/web/src/components/layout/Sidebar.tsx
git commit -m "feat(client-ai-web): AI for Office page shell with hash tabs + partner-gated nav entry" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: Final verification — type-check, full test sweep, manual smoke

No new code. Proves the whole plan hangs together before the PR. (Verification-before-completion: run every command and read the output — no claims without evidence.)

- [ ] **Step 1: Type-check apps/web (CI parity)**

CI runs `astro check` for web (`.github/workflows/ci.yml:95-97`):

```bash
cd /Users/toddhebebrand/breeze/apps/web
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec astro check
```

Expected: zero errors in `src/components/clientAi/**`, `src/pages/ai-for-office.astro`, and `src/components/layout/Sidebar.tsx`. If the baseline isn't clean, compare against a stash run (`git stash && pnpm exec astro check && git stash pop`) — only NEW errors are yours.

- [ ] **Step 2: Type-check apps/api**

```bash
cd /Users/toddhebebrand/breeze
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: only the known pre-existing errors in `agents.test.ts` and `apiKeyAuth.test.ts` — nothing in `routes/clientAi/**`.

- [ ] **Step 3: Run the full web sweep for this plan (affected files only — the full parallel suite is known-flaky)**

```bash
cd /Users/toddhebebrand/breeze/apps/web
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run \
  src/components/clientAi/AiForOfficePage.test.tsx \
  src/components/clientAi/OrgsTab.test.tsx \
  src/components/clientAi/PolicyEditor.test.tsx \
  src/components/clientAi/SessionsTab.test.tsx \
  src/components/clientAi/UsageTab.test.tsx \
  src/components/clientAi/TemplatesTab.test.tsx \
  src/lib/__tests__/no-silent-mutations.test.ts \
  src/lib/runAction.test.ts
```

Expected: all PASS.

- [ ] **Step 4: Re-run the API sweep for this plan**

```bash
cd /Users/toddhebebrand/breeze/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run \
  src/routes/clientAi/schemas.test.ts \
  src/routes/clientAi/admin.test.ts \
  src/routes/clientAi/auth.test.ts \
  src/routes/clientAi/adminOrgs.test.ts \
  src/routes/clientAi/adminSessions.test.ts \
  src/routes/clientAi/adminUsage.test.ts \
  src/routes/clientAi/adminTemplates.test.ts \
  src/routes/clientAi/templates.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Manual smoke checklist (dev stack)**

Bring up the dev stack (`docker compose -f docker-compose.yml -f docker-compose.override.yml.dev up --build -d`) with `CLIENT_AI_ENTRA_CLIENT_ID` set on the API, log in as a **partner-scope** user, open `/ai-for-office`, and verify:

1. **Nav gating** — "AI for Office" appears under AI & Fleet for the partner user; log in as an org-scope user and confirm it's hidden.
2. **Dark gate** — with `CLIENT_AI_ENTRA_CLIENT_ID` unset, the Organizations tab shows the "not enabled" notice (no spinner-forever, no error toast storm).
3. **#orgs (default)** — status chips render per org; "Set up" walks all four wizard steps against a test org: tenant GUID save (try a non-GUID → inline validation; try a tenant mapped to another org → "tenant_already_mapped" toast), consent URL copy button puts the URL on the clipboard, enable step flips the policy (org row shows AI enabled: Yes after Done), deployment instructions render. Unmap prompts for confirmation and clears the tenant column.
4. **#policy/<orgId>** — deep-link by pasting the URL with the hash: editor loads, every section renders; add a custom DLP rule, paste sample text, watch the live match count; break the pattern (`(`) and confirm save is blocked with a toast; save a budget in dollars and re-open to see it round-trip (cents conversion).
5. **#sessions** — filters narrow the list (org → user select populates; flagged-only); clicking a row opens the transcript with redaction badges, workbook chips, and the tool trail; flag with a reason → amber row accent + reason tooltip in the list; unflag via confirm.
6. **#usage** — month range defaults to the current month; org rows expand to per-user rows; totals row matches the CSV: Export CSV downloads `client-ai-usage-<from>-to-<to>.csv` and the columns read `month,org_name,user_email,messages,sessions,input_tokens,output_tokens,cost_cents`.
7. **#templates** — create an "All orgs" template and an org-scoped one (badges differ); edit shows the scope select disabled; delete asks for confirmation; the org-scoped template appears for that org's client via `GET /client-ai/templates` (curl with a Plan-1 client session token, or defer to the Plan-5 add-in test).
8. **Hash routing** — reload on each tab lands on the same tab; browser Back from #policy/<orgId> returns to #orgs (hashchange listener).

- [ ] **Step 6: Confirm a clean tree**

```bash
cd /Users/toddhebebrand/breeze && git status --short
```

Expected: empty (every task committed its own files). If the smoke pass forced fixes, commit them as `fix(client-ai-web): <what> (post-smoke)` with the Co-Authored-By trailer before opening the PR.
