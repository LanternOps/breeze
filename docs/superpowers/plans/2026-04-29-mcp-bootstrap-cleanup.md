# MCP Bootstrap Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the MCP bootstrap module (unauth `create_tenant`/`verify_tenant`/`attach_payment_method` + `/activate/<token>` flow) with a single canonical signup that flows through the OAuth Create Account branch on hosted, and is gated on the existing `partners.status` lifecycle.

**Architecture:** Claude.ai's MCP client OAuths at connector-add time, before any tool call. The OAuth login screen offers a **Create Account** branch that routes to the consolidated `/auth/register-partner` endpoint, which always creates a partner row but sets `status = 'trial'` on hosted (`IS_HOSTED=true`) so the existing `partnerGuard` middleware blocks all features until `breeze-billing` flips it to `'active'` via a signed callback. Self-host signups go straight to `'active'`. The bootstrap MCP tools, the unauth carve-out, the `/activate/<token>` flow, and the activation email service are deleted entirely. Stripe never appears in the public repo.

**Tech Stack:** TypeScript (Hono API, Astro/React web), Drizzle ORM on Postgres, `node-oidc-provider` for OAuth 2.1 + DCR, Vitest for tests.

---

## Background — read before starting

### Why this cleanup exists

The `feature/mcp-bootstrap` branch (now on `main`, ~43 commits) was designed around a flow where Claude.ai connects to the MCP endpoint *unauthenticated*, calls `create_tenant` from a prompt, walks the user through email + Stripe checkpoints, and only OAuths once the tenant is `active`. Live testing showed Claude.ai actually OAuths at **connector-add time**, before any tool call. The bootstrap carve-out is therefore invisible to the user and adds nothing — the user signs up via the OAuth Create Account branch, then Claude operates on a tenant that already exists.

The right design (agreed in chat 2026-04-29) is:

1. ONE signup endpoint (`POST /auth/register-partner`) that the web signup form, the OAuth Create Account branch, and any future programmatic caller all hit.
2. Tenant status (`partners.status`) is the only "is this account paid" abstraction in the public repo. Stripe code lives in `breeze-billing` (separate repo), which calls back to flip status when payment is verified.
3. On hosted (`IS_HOSTED=true`), new tenants land at `status='trial'`. The existing `partnerGuard` middleware (`apps/api/src/middleware/partnerGuard.ts:52`) already rejects non-`active` partners. The OAuth consent screen, post-approval, sees `status != 'active'` and redirects to the configured `BILLING_URL` instead of completing the OAuth handshake.
4. On self-host, new tenants land at `status='active'`. `BILLING_URL` is empty. `partnerGuard` lets them through. No change from today.

### Existing state — surveyed pre-plan

- **Flag:** `MCP_BOOTSTRAP_ENABLED` (`apps/api/src/config/env.ts:11`) is the de-facto "is this hosted SaaS" flag. Used in `apps/api/src/routes/auth/register.ts` to bypass the setup-admin gate, in `mcpServer.ts` to enable the unauth carve-out, in `index.ts` to mount activation/invite routes, in `services/deleteTenant.ts`, and in `mcpBootstrap/startupCheck.ts`. Plus tests + docs.
- **Tenant status enum:** `partnerStatusEnum` allows `'active' | 'suspended' | 'trial' | 'churned'` (per `openapi.ts:218`). `partnerGuard` rejects everything except `'active'`.
- **Bootstrap migration:** `apps/api/migrations/2026-04-20-a-mcp-bootstrap-schema.sql` added: `partners.{mcp_origin, mcp_origin_ip, mcp_origin_user_agent, email_verified_at, payment_method_attached_at, stripe_customer_id}`, `api_keys.scope_state`, plus tables `partner_activations` and `deployment_invites`. Per CLAUDE.md, never edit a shipped migration — we'll fix forward with a new one.
- **OAuth provider:** `node-oidc-provider` instance built in `apps/api/src/oauth/provider.ts`. Mounted at `/oauth/*` (`apps/api/src/index.ts:371`). Interaction UI handlers at `oauthInteractionRoutes` (`apps/api/src/routes/oauthInteraction.ts`). Consent base URL configured via `OAUTH_CONSENT_URL_BASE`.

### Files we are KEEPING from `mcpBootstrap/`

These are still useful and just need rehoming + de-bootstrapping:
- `tools/sendDeploymentInvites.ts` — authed-only tool, still wanted
- `tools/configureDefaults.ts` — authed-only tool, still wanted
- `inviteLandingRoutes.ts` — OS-detect landing page for invite links
- `matchInviteOnEnrollment.ts` — service that flips `deployment_invites.status='enrolled'` on first heartbeat
- `metrics.ts` — funnel metrics (some signals stay; bootstrap-activation signals go)
- `deployment_invites` table from the migration

### Files we are DELETING

- `tools/createTenant.ts`, `tools/verifyTenant.ts`, `tools/attachPaymentMethod.ts` (+ tests)
- `bootstrapSecret.ts`, `paymentGate.ts`, `startupCheck.ts`, `activationRoutes.ts` (+ tests)
- `apps/api/src/services/activationEmail.ts` (+ test)
- `apps/web/src/components/activate/`, `apps/web/src/pages/activate/`
- `partner_activations` table; `api_keys.scope_state` column

### Cross-repo dependency (`breeze-billing`) — out of public-repo scope

Phase 8 documents the contract changes that must land in the `breeze-billing` repo (separate working copy at `/Users/toddhebebrand/breeze-billing`). They are NOT executed by this plan — they're called out so the operator knows to coordinate.

---

## File map

**Created:**
- `apps/api/migrations/2026-04-29-a-cleanup-mcp-bootstrap.sql` — drops `partner_activations`, `api_keys.scope_state`
- `apps/api/src/services/billingRedirect.ts` — small helper that returns the `BILLING_URL` for inactive tenants (replaces inline `paymentGate.ts` logic)
- `apps/api/src/services/billingRedirect.test.ts`
- `internal/mcp-bootstrap/runbooks/2026-04-29-mcp-demo-cheatsheet.md` — rewritten, supersedes 2026-04-22 cheatsheet
- `internal/mcp-bootstrap/runbooks/2026-04-29-mcp-launch-storyboard.md` — rewritten, supersedes 2026-04-22 storyboard

**Renamed:**
- `apps/api/src/modules/mcpBootstrap/` → `apps/api/src/modules/mcpInvites/` (the surviving deployment-invite logic; bootstrap is gone)
- `apps/api/src/modules/mcpInvites/tools/sendDeploymentInvites.ts` (was in `mcpBootstrap/tools/`)
- `apps/api/src/modules/mcpInvites/tools/configureDefaults.ts` (was in `mcpBootstrap/tools/`)
- `apps/api/src/modules/mcpInvites/inviteLandingRoutes.ts` (was in `mcpBootstrap/`)
- `apps/api/src/modules/mcpInvites/matchInviteOnEnrollment.ts` (was in `mcpBootstrap/`)

**Modified:**
- `apps/api/src/config/env.ts` — rename `isMcpBootstrapEnabled` → `isHosted`, env var `MCP_BOOTSTRAP_ENABLED` → `IS_HOSTED`. Add `BILLING_URL`.
- `apps/api/src/routes/auth/register.ts` — set `partner.status='trial'` on hosted, accept `?return_to=oauth&interaction=<uid>` query, return redirect URL accordingly
- `apps/api/src/routes/oauthInteraction.ts` (or wherever consent post-approval lives) — when `partner.status != 'active'`, redirect to `BILLING_URL?interaction=<uid>` instead of completing
- `apps/api/src/routes/mcpServer.ts` — drop unauth carve-out, all tools require auth
- `apps/api/src/index.ts` — drop `mountActivationRoutes` import + mount; update `mountInviteLandingRoutes` import path
- `apps/api/src/services/deleteTenant.ts` — drop bootstrap-only branches
- `apps/api/src/db/schema/orgs.ts` — leave `mcp_origin*`, `email_verified_at`, `payment_method_attached_at`, `stripe_customer_id` in place (still useful); remove nothing here
- `apps/api/src/db/schema/auth.ts` (or wherever `apiKeys` lives) — drop `scopeState` column
- `apps/web/src/pages/register-partner.astro` — accept `?return_to=oauth&interaction=<uid>`, propagate to API call, follow returned redirect
- Web OAuth consent / login screens (locate during Phase 0) — add **Create Account** CTA carrying `interaction` UID

**Deleted:**
- `apps/api/src/modules/mcpBootstrap/activationRoutes.ts` + `.test.ts`
- `apps/api/src/modules/mcpBootstrap/bootstrapSecret.ts`
- `apps/api/src/modules/mcpBootstrap/paymentGate.ts` + `.test.ts`
- `apps/api/src/modules/mcpBootstrap/startupCheck.ts`
- `apps/api/src/modules/mcpBootstrap/tools/createTenant.ts` + `.test.ts`
- `apps/api/src/modules/mcpBootstrap/tools/verifyTenant.ts` + `.test.ts`
- `apps/api/src/modules/mcpBootstrap/tools/attachPaymentMethod.ts` + `.test.ts`
- `apps/api/src/modules/mcpBootstrap/types.ts` (after extracting any non-bootstrap types into the new home)
- `apps/api/src/modules/mcpBootstrap/index.ts` (replaced by `apps/api/src/modules/mcpInvites/index.ts`)
- `apps/api/src/modules/mcpBootstrap/README.md`
- `apps/api/src/services/activationEmail.ts` + `.test.ts`
- `apps/api/src/__tests__/integration/mcpBootstrap.integration.test.ts`
- `apps/api/src/routes/mcpServer.www-auth.test.ts` (covered the carve-out's missing-auth header)
- `apps/web/src/components/activate/ActivateTokenPage.tsx`
- `apps/web/src/components/activate/ActivationComplete.tsx`
- `apps/web/src/pages/activate/[token].astro`
- `apps/web/src/pages/activate/complete.astro`

---

## Phase 0 — Survey assumptions and lock branch

### Task 0.1: Verify OAuth login/consent UI lives where we think it does

**Files:**
- Read: `apps/web/src/pages/login.astro`, `apps/web/src/pages/auth.astro`
- Read: `apps/api/src/routes/oauthInteraction.ts` (entire file)
- Read: every `apps/web/src/components/**` file referenced from `oauthInteraction.ts` redirects

- [ ] **Step 1: Locate the consent UI**

Run:
```bash
grep -rn "OAUTH_CONSENT_URL_BASE\|/oauth/consent\|/oauth/login\|interaction" apps/api/src/routes/oauthInteraction.ts apps/web/src/ 2>/dev/null | head -40
```

Expected: identify the file that renders the post-OAuth-redirect consent screen and the file (if separate) that renders the login screen. Note: the consent page may be a single Astro page that handles both "you're logged in, approve?" and "log in first."

- [ ] **Step 2: Locate where post-consent decides what to do**

Run:
```bash
grep -n "interactionFinished\|grantId\|prompt.name\|consent\|login" apps/api/src/routes/oauthInteraction.ts | head -30
```

Expected: identify the handler that calls `provider.interactionFinished(...)` after the user clicks Approve. Note its file:line — Phase 2 modifies this handler to check `partner.status` first.

- [ ] **Step 3: Lock the branch and create a worktree**

Run:
```bash
git switch -c cleanup/mcp-bootstrap
git worktree add ../breeze-cleanup cleanup/mcp-bootstrap
cd ../breeze-cleanup
```

Expected: clean worktree with `cleanup/mcp-bootstrap` checked out. All subsequent tasks run in `../breeze-cleanup`.

- [ ] **Step 4: Confirm clean baseline**

Run:
```bash
pnpm install
pnpm test --filter=@breeze/api 2>&1 | tail -20
```

Expected: all API tests pass. If any fail on `main`, capture the failures so they're not blamed on this cleanup.

- [ ] **Step 5: Commit the empty starting point**

```bash
git commit --allow-empty -m "chore: open cleanup/mcp-bootstrap worktree"
```

---

## Phase 1 — Rename the SaaS flag and add trial-on-hosted to signup

This phase is purely additive: it changes the env-var name, adds a new behavior to `/auth/register-partner`, and leaves the bootstrap module fully functional. Nothing breaks if Phase 2+ are not yet started.

### Task 1.1: Rename `MCP_BOOTSTRAP_ENABLED` → `IS_HOSTED` in env config

**Files:**
- Modify: `apps/api/src/config/env.ts:11`

- [ ] **Step 1: Update the export**

Replace the `isMcpBootstrapEnabled` function with:

```ts
// Read at call time so tests can flip `IS_HOSTED` per-test without `vi.resetModules()`.
export function isHosted(): boolean {
  return envFlag('IS_HOSTED');
}

// Public billing-service URL. Empty on self-host.
export const BILLING_URL = process.env.BILLING_URL ?? '';
```

Delete the old `isMcpBootstrapEnabled` export entirely.

- [ ] **Step 2: Type-check**

Run:
```bash
cd apps/api && npx tsc --noEmit 2>&1 | grep -v "node_modules" | head -40
```

Expected: many errors of the form `Cannot find name 'isMcpBootstrapEnabled'` — these are the call sites we'll update next.

- [ ] **Step 3: Update all call sites**

Run a project-wide rename:
```bash
grep -rln "isMcpBootstrapEnabled" apps/ packages/ scripts/ 2>/dev/null | xargs sed -i '' 's/isMcpBootstrapEnabled/isHosted/g'
```

Then update the env-var name in `.env.example`, docker compose files, and CI:
```bash
grep -rln "MCP_BOOTSTRAP_ENABLED" apps/ packages/ scripts/ docker-compose*.yml .github/ 2>/dev/null | xargs sed -i '' 's/MCP_BOOTSTRAP_ENABLED/IS_HOSTED/g'
```

- [ ] **Step 4: Type-check again**

Run:
```bash
cd apps/api && npx tsc --noEmit 2>&1 | grep -v "node_modules" | head -10
```

Expected: clean (or only pre-existing test errors per CLAUDE.md memory).

- [ ] **Step 5: Run tests**

Run:
```bash
pnpm test --filter=@breeze/api 2>&1 | tail -10
```

Expected: pass. Some test files may import from `config/env` and need their env-var setup updated — fix those inline.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(api): rename MCP_BOOTSTRAP_ENABLED → IS_HOSTED

The flag is no longer about MCP bootstrap (which is going away); it
distinguishes hosted SaaS from self-host. Same semantics, honest name."
```

### Task 1.2: Test that `/register-partner` sets `status='trial'` on hosted

**Files:**
- Modify: `apps/api/src/routes/auth/register.test.ts` (locate the existing register-partner test block; add a new `describe` for hosted-mode behavior)

- [ ] **Step 1: Add the failing test**

In `apps/api/src/routes/auth/register.test.ts`, add inside the existing top-level `describe`:

```ts
describe('register-partner status on hosted vs self-host', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('creates partner with status=trial when IS_HOSTED=true', async () => {
    process.env.IS_HOSTED = 'true';
    // ... existing register-partner test setup (db mocks, redis mock, etc.)
    const res = await app.request('/register-partner', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        companyName: 'Acme Corp',
        email: 'admin@acme.test',
        password: 'CorrectHorseBatteryStaple9!',
        name: 'Admin User',
        acceptTerms: true,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    // The response shape currently returns tokens; we also need partner status.
    // For this test, assert via the createPartner mock call args.
    expect(createPartnerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'trial' }),
    );
  });

  it('creates partner with status=active when IS_HOSTED is unset', async () => {
    delete process.env.IS_HOSTED;
    // ... same setup as above
    const res = await app.request('/register-partner', { /* same body */ });
    expect(res.status).toBe(201);
    expect(createPartnerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' }),
    );
  });
});
```

(Adapt mock setup to match the existing test file's pattern — copy the boilerplate from the nearest existing register-partner test.)

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd apps/api && npx vitest run src/routes/auth/register.test.ts -t "status on hosted vs self-host"
```

Expected: FAIL — `createPartner` is being called without an explicit `status`, which defaults to `'active'` from the schema.

- [ ] **Step 3: Implement: pass `status` to `createPartner` in `register.ts`**

In `apps/api/src/routes/auth/register.ts`, find the `createPartner({...})` call inside the `/register-partner` handler and add the `status` field:

```ts
const partner = await createPartner({
  // ...existing fields (name, slug, type, plan, billingEmail, etc.)
  status: isHosted() ? 'trial' : 'active',
});
```

If `createPartner` doesn't currently accept `status`, add it to the signature in `apps/api/src/services/partnerCreate.ts` and pass it through to the insert.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd apps/api && npx vitest run src/routes/auth/register.test.ts -t "status on hosted vs self-host"
```

Expected: PASS.

- [ ] **Step 5: Run full register suite to confirm no regression**

Run:
```bash
cd apps/api && npx vitest run src/routes/auth/register.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/auth/register.ts apps/api/src/routes/auth/register.test.ts apps/api/src/services/partnerCreate.ts
git commit -m "feat(api): /register-partner sets status=trial on hosted

Hosted tenants need to add a payment method via breeze-billing before
they're usable. Existing partnerGuard (status != 'active' → 402) gates
all features. Self-host signups remain status='active'."
```

### Task 1.3: Add `BILLING_URL` to `.env.example` and CLAUDE.md

**Files:**
- Modify: `.env.example` (root and `apps/api/.env.example` if separate)
- Modify: `CLAUDE.md` (add a one-line note in the env-vars section if one exists, or in the multi-tenant section)

- [ ] **Step 1: Add to `.env.example`**

Append to `.env.example`:

```
# Hosted SaaS only — URL to breeze-billing's payment-setup landing page.
# Empty on self-host (no billing service running).
BILLING_URL=
```

- [ ] **Step 2: Commit**

```bash
git add .env.example apps/api/.env.example 2>/dev/null
git commit -m "chore: document BILLING_URL env var for hosted mode"
```

---

## Phase 2 — Wire OAuth consent → BILLING_URL redirect (existing auth chain reused)

**Pre-implementation discovery (2026-04-29):** The OAuth login → signup → back-to-consent chain ALREADY EXISTS end-to-end. Specifically:

- `apps/web/src/components/oauth/ConsentForm.tsx` — `loginRedirectTarget()` redirects unauth users to `/auth?next=/oauth/consent?uid=<UID>`
- `apps/web/src/pages/auth.astro` — renders `<AuthPage next={next} />`
- `apps/web/src/components/auth/AuthPage.tsx:9-64` — has Sign In / **Sign Up** tabs; the Sign Up tab renders `<PartnerRegisterPage next={next} />`
- `apps/web/src/components/auth/PartnerRegisterPage.tsx:43` — already does `navigateTo(result.redirectUrl ?? safeNext)` — follows the API's `redirectUrl` if present, otherwise `next`
- `apps/api/src/routes/auth/register.ts:330` — already supports returning `redirectUrl` in the response

So the only Phase 2 work is the **consent handler's BILLING_URL redirect** and an **OAuth interaction TTL bump**. The `?return_to=oauth&interaction=<uid>` scheme from the original draft is unnecessary — the existing `?next=<url>` chain handles signup→consent navigation already. Tasks 2.1, 2.3, 2.4 from the original draft are deleted.

### Task 2.1: Consent handler redirects to BILLING_URL when `partner.status != 'active'`

**Files:**
- Modify: `apps/api/src/routes/oauthInteraction.ts` (consent POST handler at line 173 — insertion point is between `if (!hasAccess)` at line 214 and `const grant = new (provider as any).Grant(...)` at line 216)
- Modify: `apps/api/src/routes/oauthInteraction.test.ts`

- [ ] **Step 1: Add the failing tests**

Read `apps/api/src/routes/oauthInteraction.test.ts` first to understand the test setup (Hono request mocks, db mock pattern). Add three new test cases adjacent to existing `/interaction/:uid/consent` tests, mirroring their fixture style:

```ts
describe('consent redirects inactive partners to BILLING_URL', () => {
  it('returns redirectTo BILLING_URL when partner.status=trial and BILLING_URL is set', async () => {
    process.env.BILLING_URL = 'https://billing.example.com/setup';
    // Set up: user is a member of partner-x; partner-x.status = 'trial'.
    // Mock the existing partnerUsers join to return a membership row, AND
    // the new partners select to return { status: 'trial' }.
    const res = await app.request('/oauth/interaction/abc-123/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: validAuthCookie },
      body: JSON.stringify({ partner_id: 'partner-x', approve: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redirectTo).toBe('https://billing.example.com/setup?uid=abc-123');
  });

  it('falls through to grant.save when partner.status=active', async () => {
    process.env.BILLING_URL = 'https://billing.example.com/setup';
    // Set up: same membership, but partners.status = 'active'.
    const res = await app.request('/oauth/interaction/abc-123/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: validAuthCookie },
      body: JSON.stringify({ partner_id: 'partner-x', approve: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Existing code returns the oidc-provider /oauth/auth/<uid> URL on success
    expect(body.redirectTo).toMatch(/\/oauth\/auth\/abc-123$/);
  });

  it('returns 402 when status=trial and BILLING_URL is empty', async () => {
    delete process.env.BILLING_URL;
    const res = await app.request('/oauth/interaction/abc-123/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: validAuthCookie },
      body: JSON.stringify({ partner_id: 'partner-x', approve: true }),
    });
    expect(res.status).toBe(402);
  });
});
```

The implementer must adapt mock setup to match the existing test file (the file uses Vitest mocks for `db`, the OIDC provider, and `interactionDetails`). Copy the boilerplate from the nearest existing `/interaction/:uid/consent` test and add a `partners.status` mock to it.

- [ ] **Step 2: Run tests to verify FAIL**

Run:
```bash
cd /Users/toddhebebrand/breeze-cleanup/apps/api && npx vitest run src/routes/oauthInteraction.test.ts -t "BILLING_URL"
```

Expected: FAIL — handler doesn't check `partner.status` yet.

- [ ] **Step 3: Implement in `oauthInteraction.ts`**

Add `BILLING_URL` to the existing env imports near the top of the file:

```ts
import { OAUTH_ISSUER, OAUTH_RESOURCE_URL, BILLING_URL } from '../config/env';
```

Add `partners` to the schema imports (verify `partners` isn't already imported via the existing `partnerUsers`/`users` imports — if it's not, add it):

```ts
import { partners, partnerUsers, users } from '../db/schema';
```

Insert this block in the consent POST handler at line 215 (immediately after `if (!hasAccess) throw new HTTPException(403, { message: 'not a member of this partner' });` and BEFORE `const grant = new (provider as any).Grant(...)`):

```ts
const [partnerRow] = await asSystem(async () =>
  db
    .select({ status: partners.status })
    .from(partners)
    .where(eq(partners.id, body.partner_id))
    .limit(1),
);
if (!partnerRow) {
  throw new HTTPException(404, { message: 'partner not found' });
}
if (partnerRow.status !== 'active') {
  if (BILLING_URL) {
    // Hand off to breeze-billing. On payment success, breeze-billing
    // flips partners.status='active' and returns the user to
    // /oauth/consent?uid=<UID>, where this handler will fall through
    // to grant.save() below.
    return c.json({
      redirectTo: `${BILLING_URL}?uid=${encodeURIComponent(c.req.param('uid'))}`,
    });
  }
  throw new HTTPException(402, { message: 'subscription_required' });
}
```

- [ ] **Step 4: Run tests to verify PASS**

Run:
```bash
cd /Users/toddhebebrand/breeze-cleanup/apps/api && npx vitest run src/routes/oauthInteraction.test.ts
```

Expected: all consent tests pass (including existing ones — they default to `partners.status='active'` in their fixtures or need a small mock update; the implementer fixes any mock that newly fails).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/oauthInteraction.ts apps/api/src/routes/oauthInteraction.test.ts
git commit -m "feat(api): consent redirects inactive partners to BILLING_URL

When the user approves consent for a partner whose status != 'active',
hand off to the configured billing service. breeze-billing flips status
to active and returns the user to /oauth/consent?uid=<UID>, where this
handler falls through to grant.save().

Self-host (no BILLING_URL) returns 402 if a non-active partner ever
reaches consent — should not happen since signup sets status='active'
on self-host."
```

### Task 2.2: Bump OAuth interaction TTL to 20 minutes

**Files:**
- Modify: `apps/api/src/oauth/provider.ts`

- [ ] **Step 1: Locate the `cookies` / `ttl` config**

Run:
```bash
grep -n "ttl:\|cookies:\|interaction:" apps/api/src/oauth/provider.ts | head -20
```

Find the `oidc-provider` configuration object. The interaction cookie TTL is typically in `cookies.short` or a `ttl.Interaction` field.

- [ ] **Step 2: Set interaction TTL to 20 minutes**

In the provider config object, add (or modify):

```ts
ttl: {
  // ... existing entries
  Interaction: 20 * 60, // 20 min — covers signup form + breeze-billing round-trip
  Session: 60 * 60,     // keep / set per existing
},
cookies: {
  // ... existing entries
  long: { signed: true, maxAge: 14 * 24 * 60 * 60 * 1000 },
  short: { signed: true, maxAge: 20 * 60 * 1000 },
},
```

- [ ] **Step 3: Run OAuth tests**

Run:
```bash
cd apps/api && npx vitest run src/oauth/ src/routes/oauth*.test.ts
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/oauth/provider.ts
git commit -m "chore(oauth): bump Interaction TTL to 20m

Signup flow on hosted is form (~30s) → billing redirect (~60-90s in
breeze-billing) → return to consent. Default 10m TTL was tight; 20m
gives comfortable headroom."
```

---

## Phase 3 — Delete bootstrap MCP tools and the unauth carve-out

After Phase 2, the OAuth Create Account branch is the canonical signup path. The bootstrap MCP tools are no longer reachable in any user-facing flow. Time to delete them.

### Task 3.1: Delete the three bootstrap tools and their tests

**Files:**
- Delete: `apps/api/src/modules/mcpBootstrap/tools/createTenant.ts` + `.test.ts`
- Delete: `apps/api/src/modules/mcpBootstrap/tools/verifyTenant.ts` + `.test.ts`
- Delete: `apps/api/src/modules/mcpBootstrap/tools/attachPaymentMethod.ts` + `.test.ts`

- [ ] **Step 1: Delete the files**

Run:
```bash
rm apps/api/src/modules/mcpBootstrap/tools/createTenant.ts \
   apps/api/src/modules/mcpBootstrap/tools/createTenant.test.ts \
   apps/api/src/modules/mcpBootstrap/tools/verifyTenant.ts \
   apps/api/src/modules/mcpBootstrap/tools/verifyTenant.test.ts \
   apps/api/src/modules/mcpBootstrap/tools/attachPaymentMethod.ts \
   apps/api/src/modules/mcpBootstrap/tools/attachPaymentMethod.test.ts
```

- [ ] **Step 2: Type-check**

Run:
```bash
cd apps/api && npx tsc --noEmit 2>&1 | grep -v "node_modules" | head -20
```

Expected: errors at any module that imported these files. Identify each.

### Task 3.2: Drop tool registration in `mcpServer.ts`

**Files:**
- Modify: `apps/api/src/routes/mcpServer.ts`
- Modify: `apps/api/src/modules/mcpBootstrap/types.ts` (deleting `BOOTSTRAP_TOOL_NAMES`)

- [ ] **Step 1: Find the registration block**

Run:
```bash
grep -n "createTenantTool\|verifyTenantTool\|attachPaymentMethodTool\|BOOTSTRAP_TOOL_NAMES" apps/api/src/routes/mcpServer.ts
```

- [ ] **Step 2: Remove the registrations and the carve-out**

In `mcpServer.ts`, delete:
- The three tool import lines
- The three tool entries from the tools registry
- The block that branches on `if (!apiKey && BOOTSTRAP_TOOL_NAMES.includes(toolName))` to allow unauth — replace with a uniform "auth required" 401 for any unauth call

The `tools/list` endpoint should now return ONLY authed tools (or an empty list with `WWW-Authenticate` header) for unauth callers.

- [ ] **Step 3: Delete `BOOTSTRAP_TOOL_NAMES`**

In `apps/api/src/modules/mcpBootstrap/types.ts`, delete the `BOOTSTRAP_TOOL_NAMES` constant. If `types.ts` becomes empty, delete the file.

- [ ] **Step 4: Run mcpServer tests**

Run:
```bash
cd apps/api && npx vitest run src/routes/mcpServer.test.ts src/routes/mcpServer.bearer.test.ts
```

Expected: many failures referencing the removed tools — these tests were verifying the carve-out behavior. Delete or rewrite them per Task 3.3.

### Task 3.3: Delete carve-out tests and integration test

**Files:**
- Delete: `apps/api/src/routes/mcpServer.www-auth.test.ts` (this test specifically validated the carve-out's `WWW-Authenticate` header on unauth calls — write a new minimal test for the always-401 behavior if one doesn't exist after the rewrite)
- Delete: `apps/api/src/__tests__/integration/mcpBootstrap.integration.test.ts`
- Modify: `apps/api/src/routes/mcpServer.test.ts` and `apps/api/src/routes/mcpServer.bearer.test.ts` — remove tests that asserted `tools/list` returns the three bootstrap tools to unauth callers

- [ ] **Step 1: Delete the dedicated tests**

Run:
```bash
rm apps/api/src/routes/mcpServer.www-auth.test.ts \
   apps/api/src/__tests__/integration/mcpBootstrap.integration.test.ts
```

- [ ] **Step 2: Surgical edits to remaining mcpServer tests**

In `mcpServer.test.ts` and `mcpServer.bearer.test.ts`, remove:
- Any `it(...)` block that asserts unauth `tools/list` returns the bootstrap tools
- Any block that calls `create_tenant`, `verify_tenant`, or `attach_payment_method`
- Any setup that mocks `bootstrap_secret` flows

Keep all tests covering authed flows and OAuth-discovered authed flows.

- [ ] **Step 3: Add a minimal "all tools require auth" test**

In `mcpServer.test.ts`, add:

```ts
it('returns empty tools list with WWW-Authenticate header for unauth callers', async () => {
  const res = await app.request('/api/v1/mcp/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toMatch(/Bearer/);
});
```

- [ ] **Step 4: Run mcpServer tests**

Run:
```bash
cd apps/api && npx vitest run src/routes/mcpServer.test.ts src/routes/mcpServer.bearer.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(mcp): remove bootstrap MCP tools and unauth carve-out

create_tenant, verify_tenant, attach_payment_method are deleted along
with the unauth carve-out in mcpServer.ts. All MCP tools now require
auth; unauth callers get 401 + WWW-Authenticate.

The signup flow they implemented now lives in /auth/register-partner,
invoked from the OAuth Create Account branch."
```

### Task 3.4: Delete `bootstrapSecret.ts`, `paymentGate.ts`, `startupCheck.ts`

**Files:**
- Delete: `apps/api/src/modules/mcpBootstrap/bootstrapSecret.ts`
- Delete: `apps/api/src/modules/mcpBootstrap/paymentGate.ts` + `.test.ts`
- Delete: `apps/api/src/modules/mcpBootstrap/startupCheck.ts`

- [ ] **Step 1: Verify no live imports**

Run:
```bash
grep -rn "bootstrapSecret\|paymentGate\|startupCheck" apps/api/src --include="*.ts" | grep -v "modules/mcpBootstrap"
```

Expected: only references inside `mcpBootstrap/` itself (which we're removing). If any live caller exists outside, address it before deleting.

- [ ] **Step 2: Delete the files**

Run:
```bash
rm apps/api/src/modules/mcpBootstrap/bootstrapSecret.ts \
   apps/api/src/modules/mcpBootstrap/paymentGate.ts \
   apps/api/src/modules/mcpBootstrap/paymentGate.test.ts \
   apps/api/src/modules/mcpBootstrap/startupCheck.ts
```

- [ ] **Step 3: Remove startup-check invocation from `index.ts`**

Run:
```bash
grep -n "startupCheck\|mcpBootstrapStartup\|startupSelfCheck" apps/api/src/index.ts
```

Delete the import + invocation lines.

- [ ] **Step 4: Type-check + test**

Run:
```bash
cd apps/api && npx tsc --noEmit 2>&1 | grep -v "node_modules" | head -10 && npx vitest run --pool threads 2>&1 | tail -15
```

Expected: clean type-check, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(mcp): delete bootstrapSecret, paymentGate, startupCheck

paymentGate's behavior (PAYMENT_REQUIRED based on
partners.payment_method_attached_at) is replaced by the existing
partnerGuard middleware checking partners.status. bootstrapSecret was
only used to authenticate the deleted unauth tools."
```

---

## Phase 4 — Delete the activation flow

### Task 4.1: Delete `/activate/<token>` API route + email service

**Files:**
- Delete: `apps/api/src/modules/mcpBootstrap/activationRoutes.ts` + `.test.ts`
- Delete: `apps/api/src/services/activationEmail.ts` + `.test.ts`
- Modify: `apps/api/src/index.ts` — remove `mountActivationRoutes` import + invocation

- [ ] **Step 1: Verify no live external callers**

Run:
```bash
grep -rn "activationEmail\|activationRoutes\|mountActivationRoutes\|sendActivationEmail" apps/api/src --include="*.ts" | grep -v "modules/mcpBootstrap\|services/activationEmail"
```

Expected: only the import + mount in `index.ts`.

- [ ] **Step 2: Remove from `index.ts`**

In `apps/api/src/index.ts`, find:

```ts
import { mountActivationRoutes, mountInviteLandingRoutes } from './modules/mcpBootstrap';
// ...
mountActivationRoutes(app);
```

Change the import to drop `mountActivationRoutes`:

```ts
import { mountInviteLandingRoutes } from './modules/mcpBootstrap';
```

And delete the `mountActivationRoutes(app);` call.

- [ ] **Step 3: Delete the files**

Run:
```bash
rm apps/api/src/modules/mcpBootstrap/activationRoutes.ts \
   apps/api/src/modules/mcpBootstrap/activationRoutes.test.ts \
   apps/api/src/services/activationEmail.ts \
   apps/api/src/services/activationEmail.test.ts
```

- [ ] **Step 4: Type-check + test**

Run:
```bash
cd apps/api && npx tsc --noEmit 2>&1 | head -10 && npx vitest run 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(api): delete /activate/<token> route + activationEmail service

These were the user-facing half of the bootstrap flow (click email →
land on activation page → Stripe). No longer reachable now that signup
is via /register-partner."
```

### Task 4.2: Delete activation web pages

**Files:**
- Delete: `apps/web/src/components/activate/ActivateTokenPage.tsx`
- Delete: `apps/web/src/components/activate/ActivationComplete.tsx`
- Delete: `apps/web/src/pages/activate/[token].astro`
- Delete: `apps/web/src/pages/activate/complete.astro`

- [ ] **Step 1: Delete the directories**

Run:
```bash
rm -rf apps/web/src/components/activate apps/web/src/pages/activate
```

- [ ] **Step 2: Verify no remaining imports**

Run:
```bash
grep -rn "ActivateTokenPage\|ActivationComplete\|/activate/" apps/web/src 2>/dev/null
```

Expected: no results.

- [ ] **Step 3: Type-check web**

Run:
```bash
pnpm test --filter=@breeze/web 2>&1 | tail -10
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(web): delete /activate/[token] + complete pages"
```

---

## Phase 5 — Schema cleanup migration

### Task 5.1: Write the cleanup migration

**Files:**
- Create: `apps/api/migrations/2026-04-29-a-cleanup-mcp-bootstrap.sql`

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-04-29-a-cleanup-mcp-bootstrap.sql`:

```sql
-- Cleanup of unused tables/columns from the deleted mcpBootstrap module.
-- See docs/superpowers/plans/2026-04-29-mcp-bootstrap-cleanup.md for context.
--
-- Idempotent (per CLAUDE.md migration rules). Safe to apply multiple times.

-- 1) Drop partner_activations: every reference came from activationRoutes.ts,
--    which is gone. RLS policies are dropped automatically with the table.
DROP TABLE IF EXISTS partner_activations;

-- 2) Drop api_keys.scope_state. The 'readonly' value was only ever set by
--    verify_tenant during pending_payment; that flow is gone, and all
--    surviving keys are 'full'. partnerGuard now governs whether tools work
--    at all (active vs trial/suspended), so a per-key scope is redundant.
ALTER TABLE api_keys DROP COLUMN IF EXISTS scope_state;

-- Intentionally KEEP on partners:
--   - mcp_origin, mcp_origin_ip, mcp_origin_user_agent: useful audit trail
--     for tenants created via OAuth Create Account branch.
--   - email_verified_at: still set by future email-verification flows.
--   - payment_method_attached_at: kept as a denormalized timestamp that
--     breeze-billing populates via the activate callback.
--   - stripe_customer_id: used by breeze-billing for customer lookups.
--
-- Intentionally KEEP table deployment_invites: still used by the surviving
-- send_deployment_invites tool.
```

- [ ] **Step 2: Update Drizzle schema to drop `scopeState`**

In whichever schema file defines `api_keys` (likely `apps/api/src/db/schema/auth.ts` or `apiKeys.ts`), remove the `scopeState` column definition.

Run:
```bash
grep -rln "scopeState\|scope_state" apps/api/src/db/schema/
```

Edit each file to remove the column.

- [ ] **Step 3: Run migrations + drift check**

Run:
```bash
docker compose up -d postgres  # if not running
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && pnpm db:check-drift
```

Expected: no drift after migration applies.

- [ ] **Step 4: Run tests touching api_keys**

Run:
```bash
cd apps/api && npx vitest run --testNamePattern "api.?key|apiKey"
```

Expected: pass. Fix any test that referenced `scopeState`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-04-29-a-cleanup-mcp-bootstrap.sql apps/api/src/db/schema/
git commit -m "chore(db): drop partner_activations + api_keys.scope_state

Both became unreachable when the bootstrap activation flow was deleted.
Intentionally keep partners.{mcp_origin*, email_verified_at, payment_method_attached_at, stripe_customer_id}
and the deployment_invites table — still in use."
```

---

## Phase 6 — Reorganize surviving files (rename module to `mcpInvites`)

The surviving files (`sendDeploymentInvites`, `configureDefaults`, `inviteLandingRoutes`, `matchInviteOnEnrollment`, `metrics`) all belong to a coherent feature: *agent-driven device deployment*. Renaming the directory makes that clear and eliminates the misleading "bootstrap" name.

### Task 6.1: Rename directory and update imports

**Files:**
- Rename: `apps/api/src/modules/mcpBootstrap/` → `apps/api/src/modules/mcpInvites/`
- Modify: every file with an import path containing `mcpBootstrap`

- [ ] **Step 1: Move the directory**

Run:
```bash
git mv apps/api/src/modules/mcpBootstrap apps/api/src/modules/mcpInvites
```

- [ ] **Step 2: Update import paths**

Run:
```bash
grep -rln "modules/mcpBootstrap\|from '\\.\\./mcpBootstrap" apps/api/src --include="*.ts" | xargs sed -i '' 's|modules/mcpBootstrap|modules/mcpInvites|g'
```

- [ ] **Step 3: Update `index.ts` import**

`apps/api/src/index.ts` should now import from `./modules/mcpInvites`. Verify:

```bash
grep -n "mcpInvites\|mcpBootstrap" apps/api/src/index.ts
```

Expected: only `mcpInvites`.

- [ ] **Step 4: Update README**

Rename `apps/api/src/modules/mcpInvites/README.md` content to describe the surviving scope. Replace existing content with:

```markdown
# mcpInvites

Authenticated MCP tools and HTTP routes that support agent-driven device
deployment:

- `send_deployment_invites` — MCP tool that emails install links to a list
  of staff
- `configure_defaults` — MCP tool that applies a baseline of policies to
  a fresh tenant
- `inviteLandingRoutes` — HTTP `/install/<token>` landing page that
  auto-detects OS and serves the right installer
- `matchInviteOnEnrollment` — service that flips `deployment_invites.status`
  to `enrolled` on first heartbeat
- `metrics` — funnel counters for invite → click → enrolled

This module was previously called `mcpBootstrap`. The bootstrap-specific
tools (`create_tenant`, `verify_tenant`, `attach_payment_method`) and the
`/activate/<token>` flow were removed in 2026-04-29 — see
`docs/superpowers/plans/2026-04-29-mcp-bootstrap-cleanup.md`.
```

- [ ] **Step 5: Type-check + test**

Run:
```bash
cd apps/api && npx tsc --noEmit 2>&1 | head -10 && npx vitest run 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: rename mcpBootstrap module to mcpInvites

The surviving files (send_deployment_invites, configure_defaults, invite
landing page, enrollment matcher, metrics) are about agent-driven device
deployment, not tenant bootstrap. Rename to match."
```

### Task 6.2: De-bootstrap surviving tool descriptions

**Files:**
- Modify: `apps/api/src/modules/mcpInvites/tools/sendDeploymentInvites.ts`
- Modify: `apps/api/src/modules/mcpInvites/tools/configureDefaults.ts`

- [ ] **Step 1: Edit `send_deployment_invites` description**

In `sendDeploymentInvites.ts`, replace lines that reference the deleted tools. Change:

```ts
'Call this after verify_tenant returns active. Requires a payment method on file; if you get PAYMENT_REQUIRED, call attach_payment_method first.',
```

to:

```ts
'Sends install-link emails to a list of staff. Requires an active tenant. If the tenant is inactive (status=trial or suspended), the call returns 402 with a billing_url the user must visit.',
```

- [ ] **Step 2: Edit `configure_defaults` similarly**

Find any line in `configureDefaults.ts` mentioning `verify_tenant`, `create_tenant`, or `attach_payment_method`. Replace with active-tenant phrasing.

- [ ] **Step 3: Run tool tests**

Run:
```bash
cd apps/api && npx vitest run src/modules/mcpInvites/tools/
```

Expected: pass. Update any test that asserted the old description text.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/mcpInvites/tools/
git commit -m "chore(mcp): remove references to deleted bootstrap tools from descriptions"
```

---

## Phase 7 — Documentation rewrite

### Task 7.1: Write the new demo cheatsheet

**Files:**
- Create: `internal/mcp-bootstrap/runbooks/2026-04-29-mcp-demo-cheatsheet.md`
- Modify: `internal/mcp-bootstrap/runbooks/2026-04-22-mcp-bootstrap-live-demo-cheatsheet.md` — add a single "SUPERSEDED" line at the top pointing to the new file

- [ ] **Step 1: Write `2026-04-29-mcp-demo-cheatsheet.md`**

Use this content:

```markdown
# MCP Demo Cheat Sheet (2026-04-29)

**Replaces:** `2026-04-22-mcp-bootstrap-live-demo-cheatsheet.md` (now superseded)
**For:** live audience or filmed walkthrough · **Target wall-clock:** under 3 min from "Add MCP" to "fleet alive"

## Pre-flight (do once, ~2 min before going live)

- [ ] API has `IS_HOSTED=true` AND `MCP_OAUTH_ENABLED=true`.
- [ ] `BILLING_URL` set to the breeze-billing payment-setup URL (e.g. `https://billing.2breeze.app/setup`).
- [ ] In Claude.ai, MCP connector points at `https://2breeze.app/api/v1/mcp/message` — no auth header.
- [ ] `curl -sf https://2breeze.app/.well-known/oauth-protected-resource | jq` returns `resource` + `authorization_servers`.
- [ ] Browser tabs: Claude.ai · `https://2breeze.app/login` (already at login screen, NOT signed in — so demo shows the Create Account flow) · `docker logs breeze-api -f`.
- [ ] macOS + Windows test devices powered on, browser ready.
- [ ] Cloudflared tunnel up: `cloudflared tunnel info breeze-local` shows healthy.

## The flow (so you know what you're watching)

User clicks **Add Connector** in Claude.ai. Claude opens an OAuth tab to Breeze. The login screen offers **Sign In** or **Create Account**. They click Create Account, fill the signup form, hit submit. On hosted, the new partner lands at `status='trial'` — the OAuth consent screen sees that and redirects to `BILLING_URL`. The user completes payment in breeze-billing (separate tab/service). breeze-billing flips `status='active'` and returns the user to `/oauth/consent`. They click **Approve**. Claude.ai stores the access token and queries `tools/list` — the full ~30-tool surface appears. Done.

**No prompt yet.** That happens after auth.

## Prompts (paste after OAuth completes)

### A — Standard demo

```
Send install links to my two test machines —
todd+mac@olivetech.co and todd+win@olivetech.co.
Once they're online, give me a quick health summary.
```

### B — Show off `configure_defaults`

```
This is a small accounting firm — set sane defaults for security,
auto-approve patches that aren't critical, route alerts to me.
Then send install links to todd+mac@olivetech.co and todd+win@olivetech.co.
```

### C — Live ops (after fleet is up)

```
What's running hot on the Windows box? If anything looks suspicious,
isolate it. Then schedule patching for tonight at 2am for both devices.
```

## What to point at on screen (in order)

| # | Cue | Screen / tab | One-line narration |
|---|---|---|---|
| 1 | "Add Connector" → URL pasted → OAuth tab opens | Browser | "Single URL. No API key paste." |
| 2 | OAuth login screen, click "Create Account" | Browser | "First-time user — let's create an account." |
| 3 | Signup form (email, password, company) → submit | Browser | "30 seconds. No more friction than a normal SaaS." |
| 4 | Redirected to billing.2breeze.app (Stripe setup) | Browser (billing tab) | "Hosted requires payment on file. Test card: `4242 4242 4242 4242`." |
| 5 | Returned to `/oauth/consent` → click **Approve** | Browser | "I'm granting Claude access to my tenant." |
| 6 | Back to Claude — full tool surface visible | Claude | "Now Claude has my tenant. Authenticated." |
| 7 | Type prompt A | Claude | "Two install links. Same URL. Different installer per OS." |
| 8 | `send_deployment_invites` fires | Claude tool log | — |
| 9 | Open install link on Mac + Windows | Device browsers | "OS auto-detected — one click, one admin prompt." |
| 10 | Devices appear in Claude's `get_fleet_status` | Claude | "Both online." |
| 11 | Type prompt C — live ops | Claude | "And this is what AI-native RMM means." |
| 12 | Final fleet report | Claude | "Three minutes ago this tenant didn't exist." |

## Timing budget (~3 min clean)

| Stage | Target |
|---|---|
| Add MCP → OAuth tab opens | ~5s |
| Signup form fill | ~30s |
| billing setup (Stripe Checkout) | ~45s |
| Approve consent → tools/list returns | ~5s |
| Send invites | ~10s |
| Install on two devices in parallel | ~60-90s |
| Live ops moment | ~30s |

## If something goes wrong

| Symptom | One-line recovery |
|---|---|
| OAuth tab doesn't open | Check `MCP_OAUTH_ENABLED=true`; restart API. |
| Signup → "registration disabled" | Check `ENABLE_REGISTRATION=true`. |
| After signup, redirect goes to `/dashboard` instead of billing | OAuth interaction UID was lost — the demo browser was missing the `?return_to=oauth&interaction=` query through signup. Reload the OAuth tab and retry. |
| billing tab returns "interaction expired" | OAuth interaction TTL (20m) lapsed. Disconnect+reconnect the connector to start a fresh handshake. |
| breeze-billing → tenant stays `trial` after Stripe success | Webhook signature mismatch — check `STRIPE_WEBHOOK_SECRET` in breeze-billing matches the dashboard. Look in breeze-billing logs. |
| Authed tool returns 402 `subscription_required` | Tenant is still `trial` — billing callback to public repo's `POST /internal/partners/:id/activate` failed or hasn't arrived. Check both repos' logs. |
| Installer landing page says "invalid or already used" | Ask Claude: "resend the deployment invite to <email>" — fresh token issued. |

## Tear-down

In Claude:

```
Delete this tenant. Confirmation phrase: "delete acme corp permanently".
```

If Claude lost auth, drop directly into Postgres:

```bash
docker exec -i breeze-postgres psql -U breeze -d breeze -c \
  "UPDATE partners SET deleted_at = now(), status = 'churned' \
   WHERE name = 'Acme Corp' AND deleted_at IS NULL;"
```

Then revoke the OAuth grant so the next demo gets a fresh handshake:

```bash
docker exec -i breeze-postgres psql -U breeze -d breeze -c \
  "DELETE FROM oauth_refresh_tokens WHERE client_id IN \
     (SELECT id FROM oauth_clients WHERE metadata->>'client_name' ILIKE '%claude%');"
```
```

- [ ] **Step 2: Mark old cheatsheet superseded**

Edit the top of `internal/mcp-bootstrap/runbooks/2026-04-22-mcp-bootstrap-live-demo-cheatsheet.md`, before the existing first line, add:

```markdown
> **SUPERSEDED 2026-04-29.** See [2026-04-29-mcp-demo-cheatsheet.md](./2026-04-29-mcp-demo-cheatsheet.md). Bootstrap MCP tools and `/activate/<token>` flow were deleted; signup now goes through OAuth Create Account.
```

- [ ] **Step 3: Commit**

```bash
git add internal/mcp-bootstrap/runbooks/2026-04-29-mcp-demo-cheatsheet.md \
        internal/mcp-bootstrap/runbooks/2026-04-22-mcp-bootstrap-live-demo-cheatsheet.md
git commit -m "docs: rewrite demo cheatsheet for OAuth Create Account flow"
```

### Task 7.2: Rewrite the launch-video storyboard

**Files:**
- Create: `internal/mcp-bootstrap/runbooks/2026-04-29-mcp-launch-storyboard.md`
- Modify: `internal/mcp-bootstrap/runbooks/2026-04-22-mcp-bootstrap-launch-video-storyboard.md` — add SUPERSEDED line

- [ ] **Step 1: Write the new storyboard**

Create the new file with the structure below. Reuse the old storyboard's *editor notes*, *B-roll suggestions*, *distribution variants*, *asset checklist*, and *open questions* sections almost verbatim — they're flow-agnostic. Replace ONLY the opening hook, the shot-by-shot, the VO script, and the timing table.

```markdown
# MCP Launch Video — Storyboard (2026-04-29)

**Replaces:** `2026-04-22-mcp-bootstrap-launch-video-storyboard.md`
**Working title:** "An RMM, deployed and operated by an AI, in under 3 minutes"
**Target length:** 3:00
**Aspect ratio + platforms:** unchanged from previous storyboard

## Acts

- **Act 1 (0:00-0:45) — Signup-during-OAuth.** Add MCP → OAuth tab → Create Account → pay → Approve → back in Claude. Frame this as *the entire signup of a real RMM, embedded in the OAuth handshake*. That's the novel hook.
- **Act 2 (0:45-1:45) — Deploy two devices from chat.** First prompt sent in Claude. `send_deployment_invites` fires. Mac + Windows installs in parallel. Devices appear in `get_fleet_status`.
- **Act 3 (1:45-2:45) — Live fleet ops via chat. THIS IS THE MONEYSHOT.** Show three real ops: process inspection ("Why is Chrome eating 4GB?"), a remediation (kill the process, or restart Chrome), and a scheduled task ("Patch both boxes tonight at 2am"). End on a fleet-health summary.
- **Act 4 (2:45-3:00) — Title card + CTA.** `breezermm.com/ai-agents`.

## Timing budget

| Section | Seconds | Cumulative |
|---|---|---|
| Hook | 10 | 0:10 |
| Add MCP → OAuth tab | 5 | 0:15 |
| Signup form (compressed real ~30s → 15s) | 15 | 0:30 |
| Billing tab (compressed real ~60s → 10s) | 10 | 0:40 |
| Approve consent → tools/list | 5 | 0:45 |
| First prompt + send invites | 15 | 1:00 |
| Two-device install (parallel, compressed) | 30 | 1:30 |
| Devices online + first fleet status | 15 | 1:45 |
| Live ops segment 1: process inspection | 20 | 2:05 |
| Live ops segment 2: remediation | 20 | 2:25 |
| Live ops segment 3: scheduled patching | 20 | 2:45 |
| Title card / CTA | 15 | 3:00 |

## Shot-by-shot (write inline)

The director should write the per-shot table using the same column layout as the previous storyboard: `# | Time | Shot description | On-screen | Voice-over | Director's notes`. The shots above map roughly to one row per ~10-20s segment. Compress aggressively in Acts 1 and 2 (signup + install are not the moneyshot); linger on Act 3.

## VO key lines

Three lines that MUST appear (the rest is flexible):

1. After consent Approve: "One screen. Real signup. Real card on file. The AI never had to touch your billing."
2. Opening Act 3: "Now the part nobody else can show: an AI that doesn't just deploy your fleet — it operates it."
3. Closing: "Watch your IT stack run itself."

## Editor notes, B-roll, distribution variants, assets, open questions

Copy verbatim from `2026-04-22-mcp-bootstrap-launch-video-storyboard.md` sections 4, 6, 7, 8, 9. Update only:
- Asset checklist: replace `MCP_BOOTSTRAP_ENABLED` → `IS_HOSTED`, add `BILLING_URL` requirement
- Editor notes: remove the "OAuth consent is the emotional beat" line (it now happens in Act 1, not as a mid-conversation surprise)
- Distribution variants: the 60-second cut now keeps Acts 1 (compressed to 15s), 2 (compressed to 20s), and 3 (full 25s). The Approve click is no longer the cleanest "I gave an agent access" frame — the live-ops moment is.
```

The file should be written with literal markdown content above (not the code-block wrapping shown here). Total length ~120 lines vs. the original's 220 — leaner because the old "wedge between human and AI checkpoints" framing is gone.

- [ ] **Step 2: Mark old storyboard superseded**

Same pattern as Task 7.1, Step 2.

- [ ] **Step 3: Commit**

```bash
git add internal/mcp-bootstrap/runbooks/2026-04-29-mcp-launch-storyboard.md \
        internal/mcp-bootstrap/runbooks/2026-04-22-mcp-bootstrap-launch-video-storyboard.md
git commit -m "docs: rewrite launch-video storyboard for OAuth Create Account flow

Acts: signup-during-OAuth (30s) · deploy two devices (60s) · live fleet
ops via chat (90s). Live ops is the new moneyshot."
```

### Task 7.3: Update rehearsal runbook + handoff doc

**Files:**
- Modify: `internal/mcp-bootstrap/runbooks/2026-04-20-mcp-bootstrap-demo-rehearsal.md` — add SUPERSEDED line, point at new cheatsheet
- Modify: `internal/mcp-bootstrap/runbooks/2026-04-22-mcp-bootstrap-handoff.md` — append a 2026-04-29 section documenting what was deleted, why, and what replaced it

- [ ] **Step 1: Mark rehearsal runbook superseded**

```markdown
> **SUPERSEDED 2026-04-29.** See `2026-04-29-mcp-demo-cheatsheet.md`. The rehearsal flow described below referenced unauth bootstrap MCP tools that no longer exist.
```

- [ ] **Step 2: Append cleanup section to handoff doc**

Add at the bottom of `2026-04-22-mcp-bootstrap-handoff.md`:

```markdown
---

## 2026-04-29 — Bootstrap module deleted

After live testing showed Claude.ai OAuths at connector-add time (not at first authed call), the bootstrap MCP tools and `/activate/<token>` flow became unreachable. Cleaned up in PR #TBD per `docs/superpowers/plans/2026-04-29-mcp-bootstrap-cleanup.md`.

**Deleted:** `create_tenant`, `verify_tenant`, `attach_payment_method` MCP tools; unauth carve-out in `mcpServer.ts`; `/activate/<token>` page; `activationEmail` service; `bootstrapSecret`, `paymentGate`, `startupCheck`; `partner_activations` table; `api_keys.scope_state` column.

**Renamed:** `MCP_BOOTSTRAP_ENABLED` → `IS_HOSTED`; `apps/api/src/modules/mcpBootstrap/` → `apps/api/src/modules/mcpInvites/`.

**Replaced by:** OAuth Create Account branch on the OAuth login screen → `/auth/register-partner` → on hosted, partner created at `status='trial'` → `partnerGuard` blocks access → consent handler redirects to `BILLING_URL` → breeze-billing flips status to `'active'` via signed callback → user returns to consent → Approve → Claude has full tool surface.
```

- [ ] **Step 3: Commit**

```bash
git add internal/mcp-bootstrap/runbooks/2026-04-20-mcp-bootstrap-demo-rehearsal.md \
        internal/mcp-bootstrap/runbooks/2026-04-22-mcp-bootstrap-handoff.md
git commit -m "docs: mark superseded runbooks; document cleanup in handoff"
```

### Task 7.4: Archive the deleted-design plans/specs

**Files:**
- Modify: `internal/mcp-bootstrap/specs/2026-04-20-mcp-agent-deployable-setup-design.md`
- Modify: `internal/mcp-bootstrap/plans/2026-04-20-mcp-agent-deployable-setup.md`
- Modify: `docs/superpowers/plans/2026-04-20-mcp-agent-deployable-setup.md` (if duplicate exists in public repo per the file inventory)

- [ ] **Step 1: Add SUPERSEDED line to each**

For each, prepend:

```markdown
> **SUPERSEDED 2026-04-29.** Bootstrap MCP tools and activation flow described here were deleted. See `docs/superpowers/plans/2026-04-29-mcp-bootstrap-cleanup.md` for the cleanup. The OAuth implementation plan (`internal/mcp-bootstrap/plans/2026-04-23-mcp-oauth-implementation.md`) remains current.
```

- [ ] **Step 2: Commit**

```bash
git add internal/mcp-bootstrap/ docs/superpowers/plans/2026-04-20-mcp-agent-deployable-setup.md 2>/dev/null
git commit -m "docs: mark deleted-design plans/specs superseded"
```

---

## Phase 8 — `breeze-billing` repo coordination (NOT executed by this plan)

This phase is documentation only. It calls out the changes that must land in the **separate** `breeze-billing` repo (working copy at `/Users/toddhebebrand/breeze-billing`) before this cleanup ships to hosted production. Do not edit `breeze-billing` from this worktree.

The contract:

1. **Ingress from public repo:** breeze-billing accepts `?interaction=<uid>` on its setup landing page. After successful Stripe SetupIntent, it must call back to public-repo `POST /internal/partners/:id/activate` (signed with a shared secret — name TBD, e.g. `BREEZE_BILLING_CALLBACK_SECRET`) with payload `{ partner_id, stripe_customer_id, payment_method_attached_at }`.
2. **Egress to public repo:** after callback succeeds, breeze-billing redirects the user back to `${PUBLIC_BASE_URL}/oauth/consent?interaction=<uid>`.
3. **Public-repo callback handler:** the public repo needs a new authed-by-shared-secret route at `POST /internal/partners/:id/activate` that updates `partners.status='active'` and writes the supplied `stripe_customer_id` + `payment_method_attached_at`. This route is in scope for THIS cleanup — add it as a final task.

### Task 8.1: Add the `/internal/partners/:id/activate` callback route

**Files:**
- Create: `apps/api/src/routes/internal/partnerActivate.ts`
- Create: `apps/api/src/routes/internal/partnerActivate.test.ts`
- Modify: `apps/api/src/index.ts` — mount the route under `/internal/`

- [ ] **Step 1: Add the env var**

In `apps/api/src/config/env.ts`, add:

```ts
export const BREEZE_BILLING_CALLBACK_SECRET = process.env.BREEZE_BILLING_CALLBACK_SECRET ?? '';
```

Add to `.env.example`:

```
# Hosted SaaS only — shared secret breeze-billing uses to call back into
# public repo when a payment method is verified.
BREEZE_BILLING_CALLBACK_SECRET=
```

- [ ] **Step 2: Write the failing test**

In `apps/api/src/routes/internal/partnerActivate.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { partnerActivateRoute } from './partnerActivate';

describe('POST /internal/partners/:id/activate', () => {
  beforeEach(() => {
    process.env.BREEZE_BILLING_CALLBACK_SECRET = 'test-secret';
  });

  it('rejects requests without the shared-secret header', async () => {
    const app = new Hono().route('/', partnerActivateRoute);
    const res = await app.request('/internal/partners/p1/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stripe_customer_id: 'cus_x' }),
    });
    expect(res.status).toBe(401);
  });

  it('flips status=active and writes stripe_customer_id when secret matches', async () => {
    // mock db.update(...).where(...).returning()
    const updateSpy = vi.fn().mockResolvedValue([{ id: 'p1', status: 'active' }]);
    // ... wire mock
    const app = new Hono().route('/', partnerActivateRoute);
    const res = await app.request('/internal/partners/p1/activate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-breeze-billing-secret': 'test-secret',
      },
      body: JSON.stringify({
        stripe_customer_id: 'cus_x',
        payment_method_attached_at: '2026-04-29T12:00:00Z',
      }),
    });
    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        stripeCustomerId: 'cus_x',
      }),
    );
  });
});
```

- [ ] **Step 3: Run test (expect FAIL)**

Run:
```bash
cd apps/api && npx vitest run src/routes/internal/partnerActivate.test.ts
```

Expected: FAIL — file doesn't exist.

- [ ] **Step 4: Implement**

Create `apps/api/src/routes/internal/partnerActivate.ts`:

```ts
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { partners } from '../../db/schema';
import { BREEZE_BILLING_CALLBACK_SECRET } from '../../config/env';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';

const bodySchema = z.object({
  stripe_customer_id: z.string().min(1),
  payment_method_attached_at: z.string().datetime(),
});

export const partnerActivateRoute = new Hono();

partnerActivateRoute.post(
  '/internal/partners/:id/activate',
  zValidator('json', bodySchema),
  async (c) => {
    const provided = c.req.header('x-breeze-billing-secret');
    if (!BREEZE_BILLING_CALLBACK_SECRET || provided !== BREEZE_BILLING_CALLBACK_SECRET) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const partnerId = c.req.param('id');
    const { stripe_customer_id, payment_method_attached_at } = c.req.valid('json');
    const [row] = await db
      .update(partners)
      .set({
        status: 'active',
        stripeCustomerId: stripe_customer_id,
        paymentMethodAttachedAt: new Date(payment_method_attached_at),
        updatedAt: new Date(),
      })
      .where(eq(partners.id, partnerId))
      .returning({ id: partners.id, status: partners.status });
    if (!row) return c.json({ error: 'partner_not_found' }, 404);
    return c.json({ id: row.id, status: row.status });
  },
);
```

- [ ] **Step 5: Mount in `index.ts`**

In `apps/api/src/index.ts`, near the other route mounts:

```ts
import { partnerActivateRoute } from './routes/internal/partnerActivate';
// ...
app.route('/', partnerActivateRoute);
```

- [ ] **Step 6: Run test (expect PASS)**

Run:
```bash
cd apps/api && npx vitest run src/routes/internal/partnerActivate.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/internal/ apps/api/src/index.ts apps/api/src/config/env.ts .env.example
git commit -m "feat(api): POST /internal/partners/:id/activate callback for breeze-billing

Shared-secret-authed endpoint that flips partner.status='active' and
records the Stripe customer ID + payment-method timestamp. Called by
breeze-billing after successful SetupIntent.

The breeze-billing repo must be updated to:
  1. POST here on setup_intent.succeeded with the shared secret
  2. Redirect the user back to /oauth/consent?interaction=<uid>"
```

---

## Self-review checklist (run before opening PR)

After completing all phases:

- [ ] **Spec coverage:** Every change agreed in chat (rename flag, status=trial on hosted, OAuth Create Account branch, consent → billing redirect, delete bootstrap tools, delete activation flow, schema cleanup, doc rewrite, breeze-billing callback) maps to at least one task above.
- [ ] **Placeholder scan:** `grep -n "TBD\|TODO\|implement later" docs/superpowers/plans/2026-04-29-mcp-bootstrap-cleanup.md` returns no matches in tasks (only in cross-repo Phase 8 callouts where the breeze-billing repo's PR# is unknowable from here).
- [ ] **Type consistency:** `IS_HOSTED` flag used everywhere (not `BREEZE_HOSTED` or `IS_SAAS`). `BILLING_URL` and `BREEZE_BILLING_CALLBACK_SECRET` env-var names consistent across env.ts, .env.example, and tests.
- [ ] **Migration filename ordering:** `2026-04-29-a-cleanup-mcp-bootstrap.sql` sorts after the most recent shipped migration (lexicographically). `ls apps/api/migrations/ | sort` should show it last.
- [ ] **Cross-repo gap:** The breeze-billing PR is NOT executed by this plan — confirm an issue or task is filed against the breeze-billing repo to ship the matching changes (the user must do this manually since this plan operates in `breeze` only).

---

## After-cleanup verification

Final smoke-test before opening the PR:

1. `pnpm db:check-drift` — no drift
2. `pnpm test --filter=@breeze/api` — all pass
3. `pnpm test --filter=@breeze/web` — all pass
4. `cd e2e-tests && pnpm test` — all pass (or any failures are pre-existing per CLAUDE.md memory)
5. `grep -rn "MCP_BOOTSTRAP_ENABLED\|isMcpBootstrapEnabled\|create_tenant\|verify_tenant\|attach_payment_method\|partner_activations\|scope_state\|activationEmail\|/activate/" apps/ packages/ --include="*.ts" --include="*.tsx" --include="*.astro" --include="*.sql" 2>/dev/null` — only references are in (a) the new cleanup migration's KEEP-comments and (b) test files that intentionally describe removed behavior in test names. Anything else is a leftover.
6. Manually run the demo flow against local stack with `IS_HOSTED=true` and `BILLING_URL` pointing at a stub endpoint that immediately POSTs back to `/internal/partners/:id/activate`.
