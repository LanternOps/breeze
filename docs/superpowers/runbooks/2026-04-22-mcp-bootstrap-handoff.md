# MCP Bootstrap — Pre-Ship Handoff

**Branch:** `feature/mcp-bootstrap` (worktree at `.worktrees/mcp-bootstrap`)
**Design spec:** `docs/superpowers/specs/2026-04-20-mcp-agent-deployable-setup-design.md`
**Implementation plan:** `docs/superpowers/plans/2026-04-20-mcp-agent-deployable-setup.md`
**Demo rehearsal runbook:** `docs/superpowers/runbooks/2026-04-20-mcp-bootstrap-demo-rehearsal.md`

## What's done

42 commits implementing the full spec, plus four pre-PR RLS/auth fixes and a separate commit on the `breeze-billing` repo.

### Main repo (`feature/mcp-bootstrap`)

- Migration + Drizzle schemas (`partner_activations`, `deployment_invites`, `api_keys.scope_state`, `api_keys.source`, `partners.mcp_origin*`/`email_verified_at`/`payment_method_attached_at`/`stripe_customer_id`) — idempotent + RLS-covered (dual-axis partner/org for `deployment_invites`, partner-axis for `partner_activations`).
- `packages/shared` `validateBusinessEmail()` — free-provider + disposable-email blocklist with override file support.
- `apps/api/src/services/partnerCreate.ts` — extracted from `/register-partner`, reused by `create_tenant`.
- `apps/api/src/modules/mcpBootstrap/` — feature-flagged module (`MCP_BOOTSTRAP_ENABLED`) containing all bootstrap tools, activation routes, invite landing routes, payment gate decorator, OTel-style activation metric, README with env-var contract.
- Three unauth MCP tools: `create_tenant`, `verify_tenant`, `attach_payment_method`.
- Two authed MCP tools in `authTools`: `send_deployment_invites`, `configure_defaults`.
- `delete_tenant` — flag-independent tier-3 authed tool with typed-phrase confirmation.
- Web activation pages (`/activate/[token].astro` + `/activate/complete.astro`) and `ActivateTokenPage` / `ActivationComplete` React components.
- `/activate/:token`, `/activate/setup-intent`, `/activate/complete/webhook` API routes with Stripe webhook signature verification.
- `/i/:shortCode` OS-detecting installer landing page (Windows MSI / macOS PKG; Linux returns 501).
- `send_deployment_invites` email flow + first-enrollment invite match on `/enroll`.
- API-key "MCP Provisioning" source label in settings UI.
- E2E YAML at `e2e-tests/tests/mcp_bootstrap.yaml` — runs end-to-end after the runner extensions (unauth api steps, custom headers, `mcp_result` JSON-RPC unwrap) committed in `a28fa624`.
- Full-flow integration test at `apps/api/src/__tests__/integration/mcpBootstrap.integration.test.ts` — runs against real Postgres.
- Demo rehearsal runbook.

### breeze-billing repo

- `POST /setup-intents` endpoint at `<path-to-breeze-billing-repo>` commit `1c2df7b` on `main`. Idempotent (reuses Stripe Customer keyed on `metadata.breeze_partner_id`), returns `{ setup_url, customer_id }`. Unauthenticated — mounted at root (not under `/billing/*`) so Caddy doesn't expose it publicly.

### Pre-PR fixes (caught latent bugs)

| Commit | Bug |
|---|---|
| `589eb1b0` | Unauth bootstrap dispatch wasn't wrapped in `withSystemDbAccessContext` → RLS would reject all `create_tenant` inserts in prod |
| `e2af133f` | `partner.*` audit events written with null `orgId` → invisible to `query_audit_log` |
| `e180436c` | Activation routes (`/activate/:token`, Stripe webhook, test-mode hooks) wrote to RLS tables without system context → RLS rejection |
| `72990624` | **`apiKeyAuthMiddleware` was setting `accessiblePartnerIds: []` with an incorrect comment** — `paymentGate` reads `partners` (partner-axis RLS), so **every authed MCP call would have spuriously thrown `PAYMENT_REQUIRED`** under `breeze_app`. Now resolves `partnerId` via `api_keys.orgId → organizations.partnerId` and populates the allowlist. |

## What's left before shipping

### Deploy

#### Main repo (Breeze API + Web)

Apply the two new migrations in order, **before** flipping the flag:

```
apps/api/migrations/2026-04-20-mcp-bootstrap-schema.sql
apps/api/migrations/2026-04-20-mcp-bootstrap-invites-dual-axis.sql
apps/api/migrations/2026-04-20-api-keys-source.sql
```

All three are idempotent and safe to re-run. Apply to both US + EU Postgres before cutting over.

#### breeze-billing deploy (per memory notes — no CI/CD)

Run on **both** droplets (actual IPs live in `.env` / `internal/` — gitignored):

```bash
ssh root@<US_DROPLET_IP> 'cd /opt/breeze-billing && git pull && \
  cd /opt/breeze && docker compose build billing && docker compose up -d billing'
ssh root@<EU_DROPLET_IP> 'cd /opt/breeze-billing && git pull && \
  cd /opt/breeze && docker compose build billing && docker compose up -d billing'
```

Smoke check each:

```bash
curl -sf https://us.2breeze.app/billing/health
curl -sf https://eu.2breeze.app/billing/health
```

Then verify `POST /setup-intents` is NOT publicly exposed via Caddy (should only be reachable via internal docker network or localhost from the API container):

```bash
# From a non-trusted host — should 404 or be blocked:
curl -sI https://us.2breeze.app/setup-intents
# From inside breeze-api container — should 405 (method not allowed for GET) or 200 with POST body:
docker exec breeze-api curl -sI http://billing:3002/setup-intents
```

### Required env vars on Breeze Cloud (US + EU)

Set only when enabling the feature:

- `MCP_BOOTSTRAP_ENABLED=true`
- `STRIPE_SECRET_KEY=sk_live_...` (or `sk_test_` for staging)
- `STRIPE_WEBHOOK_SECRET=whsec_...` (from the Stripe dashboard webhook creation, see below)
- `BREEZE_BILLING_URL=http://billing:3002` (or whatever the internal hostname is per docker-compose)
- `EMAIL_PROVIDER_KEY=...` (existing global var, reused)
- `PUBLIC_ACTIVATION_BASE_URL=https://us.2breeze.app` (or eu)
- `BREEZE_REGION=us` (or eu) — used by `create_tenant`'s region mismatch check.
- `BUSINESS_EMAIL_ALLOW_OVERRIDES` (optional) — path to JSON with `{ always_allow: [...], always_block: [...] }`.

### Stripe webhook registration

For each region's Stripe account (test mode first, then live):

1. Stripe Dashboard → Developers → Webhooks → **Add endpoint**
2. URL: `https://us.2breeze.app/activate/complete/webhook` (and eu)
3. Events: `setup_intent.succeeded` (only)
4. Copy the signing secret into `STRIPE_WEBHOOK_SECRET` on the API.

### Startup verification

Boot the API with the flag on. The `checkMcpBootstrapStartup()` function throws loudly if any required env var is missing — you should see a clean start with zero warnings.

Then run the pre-flight in the demo rehearsal runbook (`docs/superpowers/runbooks/2026-04-20-mcp-bootstrap-demo-rehearsal.md` → "Pre-flight checks" section).

### End-to-end smoke

Run the YAML E2E against staging:

```bash
cd e2e-tests && \
  MCP_BOOTSTRAP_ENABLED=true MCP_BOOTSTRAP_TEST_MODE=true \
  npx tsx run.ts --mode live --test mcp_bootstrap
```

The test-mode routes bypass real email/Stripe so this can run headless in CI. It validates: create → pending_email → (simulated email click) → pending_payment + readonly key → (simulated payment) → active + full scope → authed `send_deployment_invites` → `get_fleet_status` shows invited count.

## Known follow-ups (not blocking ship)

### Risk engine integration

`configure_defaults` currently writes `partners.settings.riskProfile` as JSONB — a placeholder. No code reads this yet. When a real risk engine lands, it needs to read from `partners.settings.riskProfile` OR a migration needs to move the value somewhere more structured.

No ship-blocker because the other three baseline steps (device group, alert policy, notification channel) do real work; the risk profile is just inert setup.

### OTel MeterProvider wiring

`mcp_bootstrap_activations_total{status}` is registered against `prom-client`'s global registry, so it surfaces at the existing Prometheus scrape endpoint (`/metrics`). If/when the infra adds a real OpenTelemetry MeterProvider, `apps/api/src/modules/mcpBootstrap/metrics.ts` is the single seam to swap `prom-client` → `@opentelemetry/api`. One-file change.

### Auth model for `POST /setup-intents` on breeze-billing

Currently unauthenticated, relying on Caddy not exposing the route publicly. If future deployment topology changes (e.g. breeze-billing moved to a separate VPS reachable over the public internet), add a `BILLING_API_KEY` bearer header and update `breezeBillingClient.ts` to send it. Not urgent.

### Double-submit race on Stripe customer creation

`breeze-billing`'s `POST /setup-intents` uses `stripe.customers.search` keyed on `metadata.breeze_partner_id` for idempotency. Stripe's search is eventually consistent (~few seconds lag), so two rapid calls with the same partner_id could create two Customers. Cosmetic — webhooks reconcile via metadata and the activation-completion path only cares about ONE succeeding. Consider a local dedupe cache if this becomes noisy.

### Stripe Checkout cancel_url

The setup-intent endpoint currently uses `return_url` for both success and cancel. The activation handler should distinguish success vs cancel by querying the Checkout Session status, not by URL. Task 3.3's `ActivateTokenPage` component could be enhanced to handle the `?canceled=true` case explicitly. Minor UX polish.

### `findRecentMcpPartnerByAdminEmail` scope

The 1h idempotency window in `create_tenant` keys on `admin_email + org_name`. Two different admins at the same company setting up tenants with the same org name within 1h would get deduped to one tenant — an unlikely but theoretically possible collision. If this ever matters, tighten the key to include a per-call nonce or just drop the window to 15 minutes.

### Resend / cancel invite tools (v2)

Not built. Spec defers to v2. The dedupe logic in `send_deployment_invites` means calling it twice with the same email within 24h is a no-op — the user experience today is "wait 24h or use the existing `enrollment_keys` admin UI" which is fine for v1 but worth surfacing if the demo lands traction.

### Server-auto first-run AI health assessment (v2)

Spec defers to v2. In v1 the demo agent polls `get_fleet_status` and calls `get_fleet_health` itself to synthesize findings. For human-signup tenants (not MCP-originated), no auto-assessment happens — those users need to open the web UI.

## File map for future conversations

Key files someone picking this up should know:

```
docs/superpowers/
  specs/2026-04-20-mcp-agent-deployable-setup-design.md
  plans/2026-04-20-mcp-agent-deployable-setup.md
  runbooks/2026-04-20-mcp-bootstrap-demo-rehearsal.md
  runbooks/2026-04-22-mcp-bootstrap-handoff.md  ← you are here

apps/api/
  migrations/2026-04-20-mcp-bootstrap-schema.sql
  migrations/2026-04-20-mcp-bootstrap-invites-dual-axis.sql
  migrations/2026-04-20-api-keys-source.sql
  src/modules/mcpBootstrap/
    README.md                    (env-var contract + module purpose)
    index.ts                     (initMcpBootstrap + exports)
    types.ts                     (BootstrapTool, BootstrapContext, BootstrapError)
    startupCheck.ts              (required-env presence check)
    paymentGate.ts               (requirePaymentMethod decorator)
    metrics.ts                   (activation counter)
    activationRoutes.ts          (/activate/:token, Stripe webhook, test-mode hooks)
    inviteLandingRoutes.ts       (/i/:shortCode)
    matchInviteOnEnrollment.ts   (helper called from /enroll)
    tools/
      createTenant.ts
      verifyTenant.ts
      attachPaymentMethod.ts
      sendDeploymentInvites.ts
      configureDefaults.ts
  src/services/
    partnerCreate.ts            (extracted from /register-partner, reused)
    apiKeys.ts                  (mintApiKey)
    breezeBillingClient.ts      (HTTP client)
    activationEmail.ts
    deploymentInviteEmail.ts
    deleteTenant.ts
    aiToolsFleetStatus.ts       (get_fleet_status tool + invite funnel)
  src/__tests__/integration/
    mcpBootstrap.integration.test.ts    (end-to-end against real Postgres)
    rls-coverage.integration.test.ts    (extended for the two new tables)

apps/web/
  src/pages/activate/[token].astro
  src/pages/activate/complete.astro
  src/components/activate/ActivateTokenPage.tsx
  src/components/activate/ActivationComplete.tsx
  src/components/settings/ApiKeyList.tsx   (modified for source badge)

packages/shared/
  src/validators/businessEmail.ts
  src/validators/businessEmail.test.ts

e2e-tests/
  tests/mcp_bootstrap.yaml        (uses the new runner features)
  run.ts                          (added {{runId}} template var)
  src/steps.ts                    (auth: 'none', headers, mcp_result)
  src/types.ts                    (extended TestStep)

breeze-billing (separate repo — local clone path lives in internal/)
  src/routes/setupIntents.ts      (commit 1c2df7b on main)
  src/index.ts                    (mounts the route)
```

## Quick context for reviewers

- **Feature flag default OFF**: self-hosted OSS installs see zero behavior change.
- **Tenant isolation**: every new table is RLS-covered and listed in the contract test allowlist.
- **Abuse controls**: per-IP 3/hr, per-domain 5/day, global 200/hr rate limits on `create_tenant`; business-email-only; payment-method-on-file required for any mutating MCP call.
- **Audit trail**: every state transition + agent-initiated action is audited with `actorType='api_key'` + `initiated_by='integration'` for MCP-origin calls.
- **No new attack surface when flag is off**: the auth carve-out and activation routes are dynamically imported / conditionally mounted.

## When in doubt

The plan document (`docs/superpowers/plans/2026-04-20-mcp-agent-deployable-setup.md`) has the full task-by-task code for every file with complete bodies. The spec has the design rationale. The demo rehearsal runbook has operator steps.
