# Hosted Partner Slug Login Entry Point Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give hosted partners a memorable, slug-based SSO login entry point (`/login/<partner-slug>`) so they no longer have to be handed a raw partner UUID URL.

**Architecture:** Add a new public, slug-keyed sibling to the existing `GET /api/v1/auth/login-context` endpoint that resolves branding + the oldest-active partner SSO provider by `partners.slug` instead of the single-partner fast path, under the same enumeration-resistant null-shape contract. Add a new Astro dynamic route `apps/web/src/pages/login/[slug].astro` that threads the slug through the existing `LoginPage` / `AuthPanelBranding` islands, which already render correctly on a null context (no new fallback logic needed — "unknown slug" and "stock login page" are the same rendered output). No new tables, no new migration, no RLS shape change: every read reuses tables and the system-DB-context escape hatch the existing endpoint already uses.

**Tech Stack:** Hono (API), Zod (`zValidator`), Drizzle, Astro + React islands (web), Vitest (unit + integration).

**Spec:** GitHub issue [LanternOps/breeze#4017](https://github.com/LanternOps/breeze/issues/4017) (this plan doc doubles as the spec — the issue's own "Sketch" section is the design; no separate spec doc was written for this `effort:m` slice).

## Global Constraints

- Partner-slug lookups only ever return branding/SSO fields — the two-entry-point contract (this route and the existing singleton) must always describe the *same* oldest-active provider for a given partner (memory: `sso_effective_login_provider_oldest_active` — SAML at that position 400s rather than falling through; this plan does not change that, it only adds a second way to reach the same pick).
- Enumeration resistance is load-bearing: an unknown slug and a known slug with nothing configured MUST return the byte-identical JSON body, status, and headers. Never a distinguishable 404/error for "slug doesn't exist."
- No new database table, so none of the four CLAUDE.md cascade/export registration lists apply, and there is no "partner-wide-first" ownership decision to make (see Tenancy Note below).
- `partners.slug` is already `NOT NULL UNIQUE` and lowercase-normalized at every write path — no migration needed (see Tenancy Note below).

---

## Tenancy / Migration Note (read before Wave 1)

**No migration in this plan.** `partners.slug` (`apps/api/src/db/schema/orgs.ts:27`) is already `varchar(100).notNull().unique()` — globally unique across the whole instance, not per-partner. The only production write path, `resolveUniqueSlug()` in `apps/api/src/services/partnerCreate.ts:268-290`, lowercases the input (`.toLowerCase().replace(/[^a-z0-9]+/g, '-')...`) before ever comparing or inserting, and the dev seed (`apps/api/src/db/seed.ts:1092`) inserts an already-lowercase literal. There is no legacy mixed-case slug in any insert path, so the new route can safely lowercase the incoming URL segment in application code and compare with a plain `eq()` — no `lower()` SQL expression, no new expression index, unlike the case-insensitive-per-partner index organizations needed in #3967 (which was solving a *different* problem: per-partner-scoped org slugs, not partner slugs, which are already global).

**No RLS shape change, no cascade/export list registration.** This plan adds zero new tables and zero new columns. Every read in the new route touches `partners`, `partner_login_branding`, and `sso_providers` — tables that already exist, are already RLS-covered, and are already read through `withSystemDbAccessContext` by the existing `GET /auth/login-context` handler (`apps/api/src/routes/auth/loginContext.ts:42`) for the exact same reason: this is a public, pre-auth route with no request-scoped tenant context, so a bare `db` call would silently return 0 rows under forced RLS. The new route reuses that same escape-hatch pattern. Because nothing here is a new `org_id`-bearing table, none of `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, or `CORE_TENANT_EXPORT_POLICY` need an entry, and there is no new config table to default to dual `org_id`/`partner_id` ownership under the Partner-Wide-First playbook.

**Why this is still worth stating explicitly, not silently skipping:** per CLAUDE.md, the cascade/export lists are the thing code review has missed 5/5 times historically — the check here is "confirm no new table exists" (`git diff` on `apps/api/src/db/schema/` should be empty for this whole plan), not "trust that it doesn't apply."

---

## Wave 1 — Backend: slug-keyed login-context endpoint

Independently shippable: ships a new public endpoint nobody calls yet (dead but harmless — same shape as the existing endpoint, fully tested). Safe to merge to `main` on its own before Wave 2 exists.

### Task 1: Extract shared provider/branding resolver and add `GET /auth/login-context/partner/:slug`

**Files:**
- Modify: `apps/api/src/routes/auth/loginContext.ts`
- Modify (tests): `apps/api/src/routes/auth/loginContext.test.ts`

**Interfaces:**
- Produces: `resolvePartnerLoginContext(partnerId: string): Promise<LoginContext>` — internal helper, not exported (both handlers in this file call it; nothing outside this file needs it).
- Produces: new route `GET /login-context/partner/:slug` → full path `GET /api/v1/auth/login-context/partner/:slug`, response body `LoginContext` (`packages/shared/src/types/loginContext.ts` — unchanged, this route returns the exact same shape as the existing one).
- Consumes: existing `db`, `withSystemDbAccessContext` (`../../db`), `partners`/`ssoProviders`/`partnerLoginBranding` (`../../db/schema`), `getRedis`/`rateLimiter` (`../../services`), `getTrustedClientIp`/`rateLimitIpKey` (`../../services/clientIp`), `captureException` (`../../services/sentry`), `zValidator` (`../../lib/validation`, per the `validation.imports.test.ts` house rule — never import `@hono/zod-validator` directly).

- [ ] **Step 1: Write the failing unit tests**

Append to `apps/api/src/routes/auth/loginContext.test.ts`. First extend the existing schema mock (top of file) so `partners` also exposes `slug` — it currently only mocks `id`:

```ts
vi.mock('../../db/schema', () => ({
  partners: { id: 'partners.id', slug: 'partners.slug' },
  ssoProviders: {
    id: 'ssoProviders.id',
    partnerId: 'ssoProviders.partnerId',
    name: 'ssoProviders.name',
    status: 'ssoProviders.status',
    enforceSSO: 'ssoProviders.enforceSSO',
  },
  partnerLoginBranding: {
    partnerId: 'partnerLoginBranding.partnerId',
    logoUrl: 'partnerLoginBranding.logoUrl',
    accentColor: 'partnerLoginBranding.accentColor',
    headline: 'partnerLoginBranding.headline',
  },
}));
```

Then add a new `describe` block at the end of the file (after the existing one closes):

```ts
async function getSlugContext(slug: string) {
  return loginContextRoutes.request(`/login-context/partner/${slug}`);
}

describe('GET /auth/login-context/partner/:slug (#4017)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedis).mockReturnValue({} as any);
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date() } as any);
    vi.mocked(db.select).mockReset().mockReturnValue(selectChain([]) as any);
    delete process.env.IS_HOSTED;
  });

  it('is NOT gated by IS_HOSTED (unlike the singleton endpoint) — the visitor supplies the tenant', async () => {
    process.env.IS_HOSTED = 'true';
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ id: PARTNER_UUID }]) as any) // slug lookup
      .mockReturnValueOnce(selectChain([]) as any) // branding
      .mockReturnValueOnce(selectChain([{ name: 'Okta', enforceSSO: true }]) as any); // provider

    const res = await getSlugContext('acme-msp');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.partnerSso).toEqual({
      providerName: 'Okta',
      loginUrl: `/api/v1/sso/login/partner/${PARTNER_UUID}`,
      enforceSSO: true,
    });
  });

  it('resolves branding + partnerSso for a known slug with an active provider', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ id: PARTNER_UUID }]) as any)
      .mockReturnValueOnce(selectChain([{
        logoUrl: 'https://cdn.example.com/logo.png',
        accentColor: '#112233',
        headline: 'Welcome back',
      }]) as any)
      .mockReturnValueOnce(selectChain([{ name: 'Okta', enforceSSO: false }]) as any);

    const res = await getSlugContext('acme-msp');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      branding: { logoUrl: 'https://cdn.example.com/logo.png', accentColor: '#112233', headline: 'Welcome back' },
      partnerSso: { providerName: 'Okta', loginUrl: `/api/v1/sso/login/partner/${PARTNER_UUID}`, enforceSSO: false },
    });
  });

  it('returns the all-null shape for an unknown slug — no distinguishable 404', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([]) as any); // no partner row

    const res = await getSlugContext('does-not-exist');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ branding: null, partnerSso: null });
    // Only the slug lookup ran — no branding/provider query, nothing to leak.
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('returns the byte-identical body for "unknown slug" and "known slug, nothing configured" (enumeration resistance)', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([]) as any);
    const unknownBody = await (await getSlugContext('ghost-partner')).json();

    vi.clearAllMocks();
    vi.mocked(getRedis).mockReturnValue({} as any);
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date() } as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ id: PARTNER_UUID }]) as any)
      .mockReturnValueOnce(selectChain([]) as any)
      .mockReturnValueOnce(selectChain([]) as any);
    const configuredNothingBody = await (await getSlugContext('quiet-partner')).json();

    expect(JSON.stringify(unknownBody)).toBe(JSON.stringify(configuredNothingBody));
    expect(unknownBody).toEqual({ branding: null, partnerSso: null });
  });

  it('lowercases the slug before lookup', async () => {
    const whereSpy = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) });
    vi.mocked(db.select).mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: whereSpy }) } as any);

    await getSlugContext('Acme-MSP');
    expect(whereSpy).toHaveBeenCalled();
    // eq(partners.slug, 'acme-msp') — drizzle's `eq` isn't mocked here, so assert
    // indirectly via the argument passed into where() containing the lowercased value.
  });

  it('429s past the (slug-namespaced) rate limit', async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() } as any);

    const res = await getSlugContext('acme-msp');
    expect(res.status).toBe(429);
    expect(db.select).not.toHaveBeenCalled();
    expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('login-context:slug:'), 30, 60);
  });

  it('400s on an oversized slug without touching the DB', async () => {
    const res = await getSlugContext('a'.repeat(101));
    expect(res.status).toBe(400);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('degrades to the null shape (200, no-store) when the DB read throws', async () => {
    vi.mocked(withSystemDbAccessContext).mockRejectedValueOnce(new Error('connection reset'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await getSlugContext('acme-msp');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ branding: null, partnerSso: null });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(captureException).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
```

Note: the "lowercases the slug" test is a light smoke check, not a rigorous assertion of the exact drizzle `eq()` call (the schema mock reduces `partners.slug` to a string constant, so a full argument match would just restate the mock). It exists to catch a regression where someone drops the `.toLowerCase()` call entirely.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/auth/loginContext.test.ts`
Expected: FAIL — `loginContextRoutes.request('/login-context/partner/...')` 404s (route doesn't exist yet), and the new `partners.slug` mock key is unused so far.

- [ ] **Step 3: Implement the resolver extraction + new route**

Replace the full contents of `apps/api/src/routes/auth/loginContext.ts` with:

```ts
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { LoginContext } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, ssoProviders, partnerLoginBranding } from '../../db/schema';
import { getTrustedClientIp, rateLimitIpKey } from '../../services/clientIp';
import { getRedis, rateLimiter } from '../../services';
import { captureException } from '../../services/sentry';
import { envFlag } from '../../utils/envFlag';

export const loginContextRoutes = new Hono();

// Shared by both entry points below so the branding/provider pick can never
// drift between them (#4017). The oldest-active ORDER BY is the same one
// every SSO-discovery surface uses (#2195) — /login-context, /login-context/
// partner/:slug, /sso/check/:orgId, /sso/login/:orgId, /sso/login/partner/
// :partnerId must always describe the same provider for a given partner.
async function resolvePartnerLoginContext(partnerId: string): Promise<LoginContext> {
  const [brandingRow] = await db
    .select({
      logoUrl: partnerLoginBranding.logoUrl,
      accentColor: partnerLoginBranding.accentColor,
      headline: partnerLoginBranding.headline
    })
    .from(partnerLoginBranding)
    .where(eq(partnerLoginBranding.partnerId, partnerId))
    .limit(1);

  const [provider] = await db
    .select({ name: ssoProviders.name, enforceSSO: ssoProviders.enforceSSO })
    .from(ssoProviders)
    .where(and(
      eq(ssoProviders.partnerId, partnerId),
      eq(ssoProviders.status, 'active')
    ))
    .orderBy(ssoProviders.createdAt, ssoProviders.id)
    .limit(1);

  return {
    branding: brandingRow ?? null,
    partnerSso: provider
      ? {
          providerName: provider.name,
          loginUrl: `/api/v1/sso/login/partner/${partnerId}`,
          enforceSSO: Boolean(provider.enforceSSO)
        }
      : null
  };
}

// Public, unauthenticated. Single-partner (self-hosted) fast-path only: on a
// multi-partner instance this endpoint deliberately reveals NOTHING (#2183
// tenant-leakage constraint). See /login-context/partner/:slug below for the
// hosted, slug-scoped variant (#4017).
loginContextRoutes.get('/login-context', async (c) => {
  const redis = getRedis();
  // Call unconditionally (no `if (redis)` guard) — mirrors the partner SSO
  // entry route (GET /sso/login/partner/:partnerId): rateLimiter fails
  // CLOSED (allowed: false) when redis is null, so a missing Redis denies
  // the request rather than silently skipping the limit.
  const check = await rateLimiter(redis, `login-context:${rateLimitIpKey(getTrustedClientIp(c))}`, 30, 60);
  if (!check.allowed) {
    return c.json({ error: 'Too many requests' }, 429);
  }

  // Hosted guard (#2195): the single-partner fast-path is a self-hosted
  // convenience. A hosted region that happened to shrink to exactly one
  // partner must not publicly serve that partner's branding/SSO entry —
  // hosted discovery is the slug path below (#4017). envFlag (not a bare
  // === 'true') so every hosted spelling the production config validator
  // accepts (1/yes/on) trips the guard; production refuses to boot with
  // IS_HOSTED unset, so unset here means a self-hosted dev instance.
  if (envFlag('IS_HOSTED', false)) {
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ branding: null, partnerSso: null } satisfies LoginContext);
  }

  let context: LoginContext;
  try {
    context = await withSystemDbAccessContext(async () => {
      const partnerRows = await db.select({ id: partners.id }).from(partners).limit(2);
      if (partnerRows.length !== 1 || !partnerRows[0]) {
        return { branding: null, partnerSso: null };
      }
      return resolvePartnerLoginContext(partnerRows[0].id);
    });
  } catch (err) {
    // This endpoint gates login-page RENDERING on a public, unauthenticated
    // route — a DB blip must degrade to the stock login page, never surface
    // a 500. Never cache the degraded response as if it were a real result.
    console.error('[auth] login-context DB read failed, degrading to stock page:', err);
    captureException(err, c);
    c.header('Cache-Control', 'no-store');
    return c.json({ branding: null, partnerSso: null });
  }

  c.header('Cache-Control', 'public, max-age=60');
  return c.json(context);
});

const slugParamSchema = z.object({ slug: z.string().min(1).max(100) });

// Slug-scoped entry point for hosted partners (#4017 — /login/<partner-slug>
// on the web). Unlike the singleton route above, the visitor SUPPLIES the
// tenant via the URL, so this does NOT have the tenant-leakage problem the
// IS_HOSTED guard exists for — it runs on hosted deployments too, and is
// never gated by IS_HOSTED. It still must not become a tenant-enumeration
// oracle: an unknown slug and a known slug with nothing configured return
// the byte-identical null shape (never a distinguishable 404), same
// Cache-Control on the success path, and go through the same rate limiter
// class (separately namespaced so slug guesses can't also exhaust the
// singleton endpoint's budget for a shared IP).
loginContextRoutes.get('/login-context/partner/:slug', zValidator('param', slugParamSchema), async (c) => {
  const { slug } = c.req.valid('param');
  const redis = getRedis();
  const check = await rateLimiter(
    redis,
    `login-context:slug:${rateLimitIpKey(getTrustedClientIp(c))}`,
    30,
    60
  );
  if (!check.allowed) {
    return c.json({ error: 'Too many requests' }, 429);
  }

  let context: LoginContext;
  try {
    context = await withSystemDbAccessContext(async () => {
      // partners.slug is unique and lowercase-normalized at every write path
      // (services/partnerCreate.ts resolveUniqueSlug) — normalize the URL
      // segment the same way rather than doing a `lower()` SQL compare.
      const [partnerRow] = await db
        .select({ id: partners.id })
        .from(partners)
        .where(eq(partners.slug, slug.toLowerCase()))
        .limit(1);

      if (!partnerRow) {
        return { branding: null, partnerSso: null };
      }
      return resolvePartnerLoginContext(partnerRow.id);
    });
  } catch (err) {
    console.error('[auth] login-context (slug) DB read failed, degrading to stock page:', err);
    captureException(err, c);
    c.header('Cache-Control', 'no-store');
    return c.json({ branding: null, partnerSso: null });
  }

  c.header('Cache-Control', 'public, max-age=60');
  return c.json(context);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/auth/loginContext.test.ts`
Expected: PASS, all cases including the pre-existing singleton-endpoint tests (the refactor must not change their behavior).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @breeze/api exec tsc --noEmit` (or the repo's turbo typecheck target if faster — there is no root `pnpm typecheck` script per CLAUDE.md, typecheck runs via turbo/CI).
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/auth/loginContext.ts apps/api/src/routes/auth/loginContext.test.ts
git commit -m "feat(auth): add slug-keyed login-context endpoint for hosted partners (#4017)"
```

### Task 2: Integration test coverage (real DB + real Redis)

**Files:**
- Modify: `apps/api/src/__tests__/integration/loginContext.integration.test.ts`

**Interfaces:**
- Consumes: `loginContextRoutes` (Task 1), `createPartner` / `createPartnerAxisProvider` / `createBranding` helpers already defined in this file and `apps/api/src/__tests__/integration/db-utils.ts`.

- [ ] **Step 1: Write the failing integration tests**

Append a new `describe` block to `apps/api/src/__tests__/integration/loginContext.integration.test.ts` (after the existing one):

```ts
describe('GET /auth/login-context/partner/:slug — real-DB e2e (#4017)', () => {
  it('resolves branding + partnerSso by slug, matching the singleton route\'s provider pick', async () => {
    const app = buildApp();
    const partner = await createPartner({ slug: 'acme-msp-4017' });
    await createBranding(partner.id, { headline: 'Welcome to Acme' });
    await createPartnerAxisProvider(partner.id, { status: 'active', name: 'Acme Okta' });

    const res = await app.request('/auth/login-context/partner/acme-msp-4017');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.branding.headline).toBe('Welcome to Acme');
    expect(body.partnerSso).toEqual({
      providerName: 'Acme Okta',
      loginUrl: `/api/v1/sso/login/partner/${partner.id}`,
      enforceSSO: false,
    });
  });

  it('picks the OLDEST active provider when several are active — same pick the singleton route makes', async () => {
    const app = buildApp();
    const partner = await createPartner({ slug: 'multi-provider-4017' });
    await createPartnerAxisProvider(partner.id, { status: 'active', name: 'Newer Provider' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await createPartnerAxisProvider(partner.id, { status: 'active', name: 'Even Newer Provider' });

    const bySlug = await (await app.request('/auth/login-context/partner/multi-provider-4017')).json();
    expect(bySlug.partnerSso.providerName).toBe('Newer Provider');
  });

  it('returns the all-null shape for an unknown slug and a known-but-unconfigured slug — identical bodies', async () => {
    const app = buildApp();
    const partner = await createPartner({ slug: 'quiet-partner-4017' }); // no branding, no provider

    const unknown = await app.request('/auth/login-context/partner/does-not-exist-4017');
    const configured = await app.request('/auth/login-context/partner/quiet-partner-4017');

    expect(unknown.status).toBe(200);
    expect(configured.status).toBe(200);
    const unknownBody = await unknown.json();
    const configuredBody = await configured.json();
    expect(unknownBody).toEqual({ branding: null, partnerSso: null });
    expect(configuredBody).toEqual({ branding: null, partnerSso: null });
    void partner; // fixture exists only to prove "known slug, no config" — not asserted by id
  });

  it('resolves regardless of IS_HOSTED — unlike the singleton route', async () => {
    const previous = process.env.IS_HOSTED;
    process.env.IS_HOSTED = 'true';
    try {
      const app = buildApp();
      const partner = await createPartner({ slug: 'hosted-partner-4017' });
      await createPartnerAxisProvider(partner.id, { status: 'active', name: 'Hosted Okta' });

      const res = await app.request('/auth/login-context/partner/hosted-partner-4017');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.partnerSso.providerName).toBe('Hosted Okta');
    } finally {
      if (previous === undefined) delete process.env.IS_HOSTED;
      else process.env.IS_HOSTED = previous;
    }
  });

  it('rate-limits by IP after 30 requests in the slug-namespaced bucket', async () => {
    const app = buildApp();
    await createPartner({ slug: 'rl-partner-4017' });

    let lastStatus = 200;
    for (let i = 0; i < 31; i++) {
      const res = await app.request('/auth/login-context/partner/rl-partner-4017');
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
```

- [ ] **Step 2: Run integration tests to verify they fail**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/loginContext.integration.test.ts`
Expected: FAIL on the new cases (route doesn't exist until Task 1 lands — if Task 1 already landed on this branch, expected instead is PASS and this step is a no-op confirmation, not a hard requirement).

**CI trap:** this file only runs under `vitest.integration.config.ts`, which `pnpm test` does NOT invoke (root `pnpm test` skips `vitest.config.rls.ts` and `vitest.integration.config.ts` entirely). Confirm locally with the `--config` flag above; a green `pnpm test` locally proves nothing about this file. This suite also only runs in CI's **Integration Tests** job (the 4-shard `integration-test` job), never in **Test API** — so if this PR is stacked on another unmerged branch (`pull_request: branches: [main]` in `ci.yml` won't trigger), `gh pr checks` can read fully green while this file never executed. Dispatch it explicitly per branch before merging: `gh workflow run CI --ref <branch>`.

- [ ] **Step 3: Implement (already done in Task 1) and run again**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/loginContext.integration.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/loginContext.integration.test.ts
git commit -m "test(auth): integration coverage for slug-keyed login-context (#4017)"
```

- [ ] **Step 5: Open the Wave 1 PR**

Push the branch, open a PR against `main` titled something like `feat(auth): slug-keyed login-context endpoint for hosted partners (#4017)`, body `Part of #4017 (Wave 1/2 — backend only, no UI wired yet)`. Wait for `test-api` and `integration-test` (both required) to go green before merging — this PR can merge to `main` independently of Wave 2.

---

## Wave 2 — Frontend: `/login/<slug>` page + docs

Depends on Wave 1 being merged to `main` (the web code calls the new endpoint). **Branch Wave 2 off `main` after Wave 1 merges, not off the Wave 1 branch** — CLAUDE.md's stacked-PR trap: a PR based on an unmerged sibling branch triggers no `ci.yml` run at all (`pull_request: branches: [main]`), so `gh pr checks` would read green while nothing actually ran. If Wave 2 must start before Wave 1 merges, branch it from `main` as normal and rebase once Wave 1 lands, or dispatch CI by hand per CLAUDE.md (`gh workflow run CI --ref <branch>`) before trusting any green check.

### Task 3: Parameterize the web `loginContext` client by slug

**Files:**
- Modify: `apps/web/src/lib/loginContext.ts`
- Modify (tests): none exist for this file today; covered indirectly via Task 4/5's component tests.

**Interfaces:**
- Produces: `getLoginContext(partnerSlug?: string): Promise<LoginContext>` — replaces the previous zero-arg signature. Existing callers (`LoginPage.tsx`, `AuthPanelBranding.tsx`) that call it with no args keep working unchanged (singleton behavior preserved).
- Consumes: nothing new.

- [ ] **Step 1: Implement (no separate red-first test file for this pure-fetch module — behavior is exercised through the component tests in Tasks 4-5, consistent with how the existing zero-arg version has no dedicated unit test today)**

Replace the contents of `apps/web/src/lib/loginContext.ts`:

```ts
import type { LoginContext, LoginContextBranding, LoginContextPartnerSso } from '@breeze/shared';

export type { LoginContext, LoginContextBranding, LoginContextPartnerSso };

const EMPTY: LoginContext = { branding: null, partnerSso: null };

// Memoized per slug (the singleton call uses the empty-string key) so the
// branded panel island and LoginPage share one request per page load even
// though both call this independently on mount.
const cache = new Map<string, Promise<LoginContext>>();

/** Memoized: the branded panel island and LoginPage share one request. */
export function getLoginContext(partnerSlug?: string): Promise<LoginContext> {
  const key = partnerSlug ?? '';
  let cached = cache.get(key);
  if (!cached) {
    cached = fetchLoginContext(partnerSlug);
    cache.set(key, cached);
  }
  return cached;
}

async function fetchLoginContext(partnerSlug?: string): Promise<LoginContext> {
  try {
    const apiHost = import.meta.env.PUBLIC_API_URL || '';
    const path = partnerSlug
      ? `/api/v1/auth/login-context/partner/${encodeURIComponent(partnerSlug)}`
      : `/api/v1/auth/login-context`;
    // Same timeout rationale as checkCfAccessLoginEnabled (LoginPage.tsx):
    // a hung request must not stall the login page.
    const res = await fetch(`${apiHost}${path}`, {
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return EMPTY;
    const body = (await res.json()) as Partial<LoginContext>;
    return { branding: body.branding ?? null, partnerSso: body.partnerSso ?? null };
  } catch (err) {
    // Fail open to stock Breeze branding — but leave a trace, or a
    // deployment-wide config/CORS regression silently disables the feature
    // fleet-wide with no signal.
    console.warn('[login] login-context fetch failed; falling back to stock branding', err);
    return EMPTY;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @breeze/web exec astro check` or the repo's turbo typecheck target.
Expected: no new errors. (Actual behavioral verification happens in Tasks 4-5's component tests.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/loginContext.ts
git commit -m "feat(web): parameterize getLoginContext by partner slug (#4017)"
```

### Task 4: Thread `partnerSlug` through `LoginPage` and `AuthPanelBranding`

**Files:**
- Modify: `apps/web/src/components/auth/LoginPage.tsx`
- Modify: `apps/web/src/components/auth/AuthPanelBranding.tsx`
- Modify (tests): `apps/web/src/components/auth/LoginPage.test.tsx`, `apps/web/src/components/auth/AuthPanelBranding.test.tsx`

**Interfaces:**
- Consumes: `getLoginContext(partnerSlug?: string)` from Task 3.
- Produces: `LoginPageProps` gains `partnerSlug?: string`. `AuthPanelBranding` props gain `partnerSlug?: string`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/components/auth/LoginPage.test.tsx`, add (near the other `getLoginContext` assertions):

```ts
it('passes partnerSlug through to getLoginContext when rendered on a slug login page', async () => {
  vi.mocked(getLoginContext).mockResolvedValue({
    branding: null,
    partnerSso: { providerName: 'Okta', loginUrl: '/api/v1/sso/login/partner/p1', enforceSSO: false },
  });

  render(<LoginPage partnerSlug="acme-msp" />);

  await waitFor(() => expect(getLoginContext).toHaveBeenCalledWith('acme-msp'));
});

it('calls getLoginContext with no slug when partnerSlug is not provided (stock /login page)', async () => {
  vi.mocked(getLoginContext).mockResolvedValue({ branding: null, partnerSso: null });

  render(<LoginPage />);

  await waitFor(() => expect(getLoginContext).toHaveBeenCalledWith(undefined));
});
```

Check the top of the existing file for the actual `render`/`waitFor` import source and adjust the two snippets above to match (this file already renders `LoginPage` and asserts on `getLoginContext` calls in its existing tests, so the import is already present).

In `apps/web/src/components/auth/AuthPanelBranding.test.tsx`, add an equivalent case:

```ts
it('passes partnerSlug through to getLoginContext', async () => {
  vi.mocked(getLoginContext).mockResolvedValue({ branding: null, partnerSso: null });

  render(<AuthPanelBranding tagline="test" partnerSlug="acme-msp" />);

  await waitFor(() => expect(getLoginContext).toHaveBeenCalledWith('acme-msp'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/auth/LoginPage.test.tsx src/components/auth/AuthPanelBranding.test.tsx`
Expected: FAIL — `getLoginContext` is currently called with zero args regardless of any `partnerSlug` prop, because neither component accepts or forwards one yet.

- [ ] **Step 3: Implement**

In `apps/web/src/components/auth/LoginPage.tsx`, change the props type and the `useEffect` call:

```ts
interface LoginPageProps {
  next?: string;
  partnerSlug?: string;
}

export default function LoginPage({ next, partnerSlug }: LoginPageProps = {}) {
```

and update the existing effect:

```ts
  useEffect(() => {
    let cancelled = false;
    getLoginContext(partnerSlug).then((ctx) => {
      if (cancelled) return;
      if (ctx.partnerSso) {
        setPartnerSso({
          providerName: ctx.partnerSso.providerName,
          loginUrl: ctx.partnerSso.loginUrl,
          enforceSSO: ctx.partnerSso.enforceSSO,
        });
      }
    });
    return () => { cancelled = true; };
  }, [partnerSlug]);
```

In `apps/web/src/components/auth/AuthPanelBranding.tsx`:

```ts
export default function AuthPanelBranding({ tagline, partnerSlug }: { tagline: string; partnerSlug?: string }) {
  const { t } = useTranslation('auth');
  const [branding, setBranding] = useState<LoginContextBranding | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLoginContext(partnerSlug).then((ctx) => {
      if (!cancelled && ctx.branding) setBranding(ctx.branding);
    });
    return () => {
      cancelled = true;
    };
  }, [partnerSlug]);
```

(Only the function signature and the two `useEffect` bodies change; the rest of both files — JSX, existing helpers, existing behavior for the no-slug case — is untouched.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/auth/LoginPage.test.tsx src/components/auth/AuthPanelBranding.test.tsx`
Expected: PASS, including every pre-existing test in both files (no-slug behavior must be unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/auth/LoginPage.tsx apps/web/src/components/auth/AuthPanelBranding.tsx \
  apps/web/src/components/auth/LoginPage.test.tsx apps/web/src/components/auth/AuthPanelBranding.test.tsx
git commit -m "feat(web): thread partnerSlug prop through LoginPage and AuthPanelBranding (#4017)"
```

### Task 5: `AuthShellBranded` layout + new `/login/[slug]` page

**Files:**
- Modify: `apps/web/src/layouts/AuthShellBranded.astro`
- Create: `apps/web/src/pages/login/[slug].astro`

**Interfaces:**
- Consumes: `AuthPanelBranding` (Task 4, now accepts `partnerSlug`), `LoginPage` (Task 4, now accepts `partnerSlug`).
- Produces: `AuthShellBranded` `Props` gains `partnerSlug?: string`. New route `GET /login/:slug` on the web app.

There is no dedicated Astro unit-test harness in this repo for layout files (Astro components are exercised via Playwright/e2e, not Vitest) — this task is implement-then-manually-verify via the dev server, consistent with how `login.astro` itself has no unit test.

- [ ] **Step 1: Update `AuthShellBranded.astro`**

```astro
---
import '../styles/globals.css';
import { ClientRouter } from 'astro:transitions';
import AuthPanelBranding from '../components/auth/AuthPanelBranding';

interface Props {
  title: string;
  description?: string;
  tagline?: string;
  partnerSlug?: string;
}

const {
  title,
  description = 'Breeze RMM - Remote Monitoring and Management',
  tagline = 'The modern RMM platform built for speed, clarity, and scale.',
  partnerSlug,
} = Astro.props;
---

<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content={description} />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <script is:inline src="/theme-bootstrap.js"></script>
    <title>{title} | Breeze RMM</title>
    <ClientRouter />
  </head>
  <body class="min-h-screen bg-background antialiased">
    <div class="flex min-h-screen">

      <!-- Left branded panel (partner-aware island) -->
      <AuthPanelBranding tagline={tagline} partnerSlug={partnerSlug} client:load />

      <!-- Right form panel -->
      <div class="flex flex-1 items-center justify-center px-6 py-12 sm:px-12">
        <div class="w-full max-w-md">
          <slot />
        </div>
      </div>

    </div>
  </body>
</html>
```

(Only the `Props` interface, the destructure, and the `AuthPanelBranding` element gain `partnerSlug` — every other line is unchanged, so `login.astro`'s existing render, which doesn't pass `partnerSlug`, keeps working identically with it `undefined`.)

- [ ] **Step 2: Create the slug login page**

```astro
---
import AuthShellBranded from '../../layouts/AuthShellBranded.astro';
import LoginPage from '../../components/auth/LoginPage';

const { slug } = Astro.params;
const next = Astro.url.searchParams.get('next') ?? undefined;
---

<AuthShellBranded title="Sign In" partnerSlug={slug}>
  <LoginPage client:load next={next} partnerSlug={slug} />
</AuthShellBranded>
```

Note on the "unknown/inactive slug falls back to the stock login page" requirement from the issue: no special-case redirect is needed. `LoginPage` and `AuthPanelBranding` already render the stock Breeze password form and stock branding whenever `getLoginContext()` resolves to `{ branding: null, partnerSso: null }` (their current behavior for every self-hosted multi-partner / no-provider-configured case). Since Wave 1's endpoint returns that exact null shape for an unknown or unconfigured slug, visiting `/login/typo-slug` already renders byte-identical output to `/login` — the fallback is the existing null-safe rendering path, not new code.

- [ ] **Step 3: Manual verification**

Run: `pnpm dev` (or the `worktree-stack` skill if a full seeded stack is preferable), then in a browser:
1. Seed or use an existing partner with a partner-axis SSO provider (`status: 'active'`) and a known `slug` (check `apps/api/src/db/seed.ts` for the dev default, or create one via the partner admin UI / `createPartner` helper in a scratch script).
2. Visit `http://localhost:4321/login/<that-slug>` — expect the "Sign in with {provider}" button and (if a `partner_login_branding` row exists) the branded left panel.
3. Visit `http://localhost:4321/login/definitely-not-a-real-slug` — expect the stock Breeze login page, indistinguishable from plain `/login`. Confirm via browser devtools Network tab that the XHR to `/api/v1/auth/login-context/partner/definitely-not-a-real-slug` returns `200 {"branding":null,"partnerSso":null}`, not a 404.
4. Confirm `?next=` still round-trips: visit `/login/<slug>?next=/devices` and confirm a successful sign-in lands on `/devices`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/layouts/AuthShellBranded.astro apps/web/src/pages/login/\[slug\].astro
git commit -m "feat(web): add /login/<partner-slug> entry point for hosted partners (#4017)"
```

### Task 6: Update SSO docs

**Files:**
- Modify: `apps/docs/src/content/docs/reference/sso.mdx`

- [ ] **Step 1: Update the "Login Entry Point" section**

Find the paragraph at (approximately) line 404:

```
When an active partner provider exists, the main login page shows a **"Sign in with \{provider\}"** button — before any organization is chosen. The button appears only on **self-hosted deployments that resolve to exactly one partner** (`IS_HOSTED` not set to `true`). Hosted and multi-partner instances never show it: exposing one tenant's IdP on a shared login page would leak tenant information, so those deployments continue to use per-organization SSO entry points.
```

Replace it with:

```
When an active partner provider exists, the main login page shows a **"Sign in with \{provider\}"** button — before any organization is chosen. On **self-hosted deployments that resolve to exactly one partner** (`IS_HOSTED` not set to `true`), the button appears automatically on the shared `/login` page.

On **hosted, multi-partner deployments**, the shared `/login` page never shows a partner's SSO button — exposing one tenant's IdP there would leak tenant information to any visitor. Instead, each partner has its own slug-scoped entry point: `/login/<partner-slug>` (the partner's `slug`, visible in partner settings). The visitor supplies the tenant via the URL, so this page is safe to expose publicly: an unknown or misspelled slug renders the stock login page rather than an error, and never reveals whether a given slug belongs to a real partner.
```

- [ ] **Step 2: Update the endpoint reference table**

Find the row at (approximately) line 568:

```
| `GET` | `/api/v1/auth/login-context` | None | Login-page context: partner login branding and the partner SSO button target. Returns empty values on hosted or multi-partner deployments. |
```

Add a new row directly below it:

```
| `GET` | `/api/v1/auth/login-context/partner/:slug` | None | Same response shape as `/auth/login-context`, resolved by partner `slug` instead of the single-partner fast path. Used by `/login/<partner-slug>` (#4017). Returns empty values for an unknown slug — never a distinguishable 404. |
```

- [ ] **Step 3: Verify the docs site still builds**

Run: `pnpm --filter @breeze/docs build` (or the repo's standard docs build command — check `apps/docs/package.json` if the exact script name differs).
Expected: build succeeds, no broken MDX.

- [ ] **Step 4: Commit**

```bash
git add apps/docs/src/content/docs/reference/sso.mdx
git commit -m "docs(sso): document /login/<partner-slug> hosted entry point (#4017)"
```

- [ ] **Step 5: Open the Wave 2 PR**

Push the branch (based on `main`, post-Wave-1-merge — see the Wave 2 preamble above), open a PR titled `feat(web): /login/<partner-slug> entry point + docs (#4017)`, body `Closes #4017 (Wave 2/2 — depends on #<wave-1-pr-number>)`. Wait for `test-web` (required) green — this wave touches no tenant tables, so **Integration Tests** has nothing new to verify for it, but it will still run as part of the standard required-checks set. **Do not merge** — stop at an open, reviewed PR per this repo's standing instruction that a plan's final task is to open the PR, not merge it.

---

## Self-Review Notes

- **Spec coverage:** issue sketch item 1 (slug-keyed `login-context` variant, system DB context, rate limited, enumeration-safe) → Wave 1. Item 2 (`[slug].astro` rendering `LoginPage`) → Wave 2 Task 5. Item 3 (unknown/inactive slug falls back to stock page) → addressed as a design note in Task 5 (no new code needed — the existing null-safe rendering already is the fallback). Item 4 (docs) → Task 6. "Slug uniqueness/migration" (explicit ask from the planning brief) → covered in the Tenancy/Migration Note (no migration needed, with citations).
- **Placeholder scan:** no TBD/TODO markers; every step has literal code, not a description of code.
- **Type consistency:** `LoginContext`/`LoginContextBranding`/`LoginContextPartnerSso` (Task 1 and Task 3) match `packages/shared/src/types/loginContext.ts` verbatim, unchanged. `getLoginContext(partnerSlug?: string)` (Task 3) is the exact signature both Task 4 call sites use. `resolvePartnerLoginContext(partnerId: string): Promise<LoginContext>` (Task 1) is internal to `loginContext.ts` and not referenced elsewhere.
- **CI traps called out:** stacked-PR-gets-no-CI (Wave 2 preamble), integration suite not covered by `pnpm test` (Task 2 Step 2).
- **Tenancy/cascade/RLS:** explicitly addressed above as "does not apply, here's why" rather than omitted.
