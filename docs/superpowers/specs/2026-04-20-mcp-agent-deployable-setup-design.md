# MCP Agent-Deployable Setup — Design Spec

**Status:** Design approved, pending implementation plan
**Date:** 2026-04-20
**Author:** brainstormed with Todd
**Scope:** v1 single-plan body of work. v2 items listed at the end.

## Purpose

Extend the existing Breeze MCP server so an external AI agent (Claude, ChatGPT, Cursor, …) can provision a brand-new Breeze tenant end-to-end from a single user prompt: signup → configure → email installer invites → watch fleet come online → AI health findings. No human logs into the Breeze web UI during the agent-driven flow; the only human touchpoints are (1) clicking a verification email, (2) attaching a payment method for KYC.

Target demo: "set up RMM monitoring for my company" → under 5 minutes wall-clock to a monitored fleet with AI-assessed findings.

Primary motivation is a viral demo wedge; secondary is a real self-service SaaS path. Both matter. The feature is **gated behind a feature flag** (`MCP_BOOTSTRAP_ENABLED`, default `false`) so self-hosted open-source deployments of Breeze do not expose it by default — it is intended for Breeze Cloud (`us.`/`eu.2breeze.app`) only.

## Goals

1. A new tenant can be created, verified, payment-attached, configured, and populated with devices via MCP tools only — no web UI required by the agent.
2. The unauthenticated surface is minimal (three tools) and strictly rate-limited.
3. All existing tenant-isolation, RLS, audit, and risk-engine guarantees remain intact. The new module adds entry points, never new execution paths.
4. The feature can be disabled entirely for self-hosters via a single env flag.
5. Demo flow is reliably reproducible end-to-end for a filmed walkthrough.

## Non-goals

- New frontend beyond the `/activate/:token` activation page.
- Changes to the existing human signup flow (`/register-partner` keeps its current behavior).
- Making every Breeze feature agent-accessible — only the setup arc.
- Replacing or modifying the Go agent or installer. Enrollment via email-link already works via existing infra.
- Server-side automated first-run AI health assessment (deferred to v2; v1 relies on the external agent calling `get_fleet_health` itself).

## Decisions locked in during brainstorming

- **Email verification:** magic-link gate. `create_tenant` returns only a `tenant_id`; the admin must click a signed link before any API key is issued.
- **Business-email only:** free-provider and disposable-email domains are rejected at `create_tenant`. Maintained via `disposable-email-domains` npm package + hand-curated free-provider list, exported as a shared validator.
- **First-run AI health findings:** v1 is agent-polled (external agent calls existing `get_fleet_health` tool itself). Server-auto trigger deferred to v2.
- **Teardown tool:** included in v1. `delete_tenant` is authed tier-3+, typed-confirmation gated, flag-independent (self-hosters get it too). Soft-delete with 30-day restore.
- **Free-tier device cap:** 25 devices, hard-blocked at enrollment.
- **Region selection:** region-local MCP endpoints. Agent connects to `us.2breeze.app/mcp` or `eu.2breeze.app/mcp`; `create_tenant`'s `region` parameter must match the endpoint hit (mismatch → 400).
- **Payment model:** Approach (c) from brainstorming. API key is issued after email-click with `scope_state='readonly'`; mutations return `PAYMENT_REQUIRED` with a remediation breadcrumb pointing at `attach_payment_method`. Card-on-file upgrades the same key to `scope_state='full'` (key value unchanged; no agent re-auth).
- **MCP architecture:** Approach A — single endpoint per region, auth-aware `tools/list`. Unauth'd requests see only the three bootstrap tools; authed requests see the full 30+ tool set.
- **Packaging:** in-tree feature-flagged module at `apps/api/src/modules/mcpBootstrap/` with dynamic import on flag. Module boundary lets it be extracted later, but not now — the MCP-transport coupling makes a fully separate repo (like `breeze-billing`) more complex than it's worth.

## Architecture

### Activation state machine

```
  create_tenant            verify_tenant(polled)         attach_payment_method + Stripe complete
┌──────────────┐  email   ┌────────────────────┐ card  ┌──────────────────────┐
│ pending_email│ ───────► │ pending_payment    │ ────► │ active               │
│ (no api key) │  clicked │ readonly api key   │       │ full api key scope   │
└──────────────┘          └────────────────────┘       └──────────────────────┘
                                    │
                                    └─ mutating tools return PAYMENT_REQUIRED error
                                       pointing at attach_payment_method
```

State is stored on the existing `partners` table (new columns) plus a new `partner_activations` one-time-token table. The API key, once minted, is a normal `api_keys` row with a new `scope_state` column. On payment-attach, the same row is updated in place from `readonly` → `full`; the key value is stable across the transition so the agent's MCP client never needs to re-authenticate.

### MCP endpoint behavior

One URL per region (`/mcp`). The auth middleware is extended with a narrow carve-out:

- **Unauth'd request:** `tools/list` returns only `create_tenant`, `verify_tenant`, `attach_payment_method`. Any other tool call returns 401. If `MCP_BOOTSTRAP_ENABLED=false`, `tools/list` itself returns 401 (today's behavior preserved).
- **Authed request:** `tools/list` returns the full authed tool set (30+). The three bootstrap tools are omitted from the authed list (calling them with a key → 400 `already_authenticated`).
- **Readonly key request:** tier-1 tools work; tier-2+ tools return the `PAYMENT_REQUIRED` error shape.

### Feature flag behavior

`MCP_BOOTSTRAP_ENABLED=false` (default):
- Bootstrap tools are not dynamically imported or registered.
- `/activate/:token` route returns 404.
- `send_deployment_invites` email pipeline is inert (tool not registered either — it depends on the invite emailer which is flag-gated).
- Payment gate decorator is a no-op.
- DB migration still runs; enabling later requires no schema change.

`MCP_BOOTSTRAP_ENABLED=true` startup check fails loudly if any of these are unset: `STRIPE_SECRET_KEY`, `BREEZE_BILLING_URL`, `EMAIL_PROVIDER_KEY`, `PUBLIC_ACTIVATION_BASE_URL`.

The business-email validator and `delete_tenant` tool are **flag-independent** — generally useful, exported/registered regardless.

## Tool surface

Eight tools. Tool-description prose is product copy (agents pick tools by description), including `if X error, call Y` breadcrumbs so the agent recovers without human intervention.

### New unauthenticated bootstrap tools (flag-gated)

| Tool | Inputs | Returns |
|---|---|---|
| `create_tenant` | `org_name` (string, 2–64 chars), `admin_email` (business-email validated), `admin_name` (string), `region` (`us`\|`eu`, must match endpoint) | `{ tenant_id: uuid, activation_status: "pending_email" }` |
| `verify_tenant` | `tenant_id` | Polled. Returns one of: `{ status: "pending_email" }`, `{ status: "pending_payment", api_key, scope: "readonly" }`, `{ status: "active", api_key, scope: "full" }`, `{ status: "expired", remediation: "call create_tenant again" }` |
| `attach_payment_method` | `tenant_id` | `{ setup_url }` — Stripe Checkout (mode=setup) URL. Human clicks; agent re-polls `verify_tenant`. |

### New authed tools

| Tool | Tier | Flag-gated | Notes |
|---|---|---|---|
| `send_deployment_invites` | 3+ | yes | Mints per-recipient child enrollment keys + fires transactional email with OS-detecting install landing page. Payment-gated. |
| `configure_defaults` | 2 | yes | Opinionated baseline in one call: default device group, standard alert policy, risk engine standard profile, admin-email notification channel. Idempotent. Payment-gated. |
| `delete_tenant` | 3+ | **no** (flag-independent) | Typed confirmation: `confirmation_phrase` must match `"delete <org_name> permanently"`. Soft-delete + 30-day restore. Key-scoped: can only delete the partner the key belongs to. |

### Reused authed tools (no changes, or minimal additions)

| Tool | Notes |
|---|---|
| `get_fleet_status` | Reuse existing `query_devices`, add `since_enrolled` filter param. Returns the invite-funnel counts (`total_invited`, `invites_clicked`, `devices_enrolled`, `devices_online`, `recent_enrollments[]`). |
| `get_fleet_health` | Already exists. No change. |
| `set_alert_policy` | Reuse existing alert-policy tool. No change. |
| `get_recent_activity` | Reuse existing audit-read tool. No change. New audit event types surface here naturally. |

### Error shape for payment gate

```json
{
  "code": "PAYMENT_REQUIRED",
  "message": "This action requires a payment method on file (identity verification, no charge for free tier).",
  "remediation": {
    "tool": "attach_payment_method",
    "args": { "tenant_id": "<uuid>" }
  }
}
```

## Data model

One idempotent migration:

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

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS scope_state TEXT NOT NULL DEFAULT 'full'
    CHECK (scope_state IN ('readonly', 'full'));
```

RLS: `partner_activations` is shape-3 (partner-axis). Policy `breeze_has_partner_access(partner_id)`; added to `PARTNER_TENANT_TABLES` allowlist in `rls-coverage.integration.test.ts` in the same PR. The bootstrap write path runs under `withSystemDbAccessContext` (tools have no authed context yet).

Activation tokens: 64-char random hex, SHA-256-stored (same pattern as enrollment keys and agent tokens). Single-use, 24h TTL. Raw value lives only in the outbound email.

## End-to-end flow

1. **Agent:** `create_tenant(org_name="Acme", admin_email="alex@acme.com", region="us", admin_name="Alex")`. Server rate-limits (per-IP, per-domain, global), validates business-email, wraps the existing `/register-partner` transaction (partner + default org + site + admin user; no auto-login), inserts `partner_activations` row, dispatches transactional email with `https://us.2breeze.app/activate/<raw_token>`. Audits `partner.mcp_provisioned`. Returns `{ tenant_id, activation_status: "pending_email" }`.
2. **Agent:** polls `verify_tenant(tenant_id)` every ~5s. While the activation token is unconsumed, response is `{ status: "pending_email" }`.
3. **Human:** clicks email link → `GET /activate/<raw_token>`. Page verifies token hash + TTL + not consumed, marks `partner.email_verified_at` and the admin user's email verified, marks the activation consumed. Renders "Email verified ✓. Add payment method for identity verification (no charge)."
4. **Agent:** next `verify_tenant` poll returns `{ status: "pending_payment", api_key, scope: "readonly" }`. The readonly key is minted exactly once on the email-click transition. Agent can immediately use it for read calls (`get_fleet_status`, `get_fleet_health`).
5. **Agent:** attempts a mutation (e.g., `send_deployment_invites`) → gets `PAYMENT_REQUIRED` with remediation pointing at `attach_payment_method`.
6. **Agent:** calls `attach_payment_method(tenant_id)` → receives Stripe SetupIntent URL. Agent prompts the human to click. Human completes Stripe Checkout (mode=setup). Return URL lands at `/activate/complete?partner=<id>`; on Stripe webhook `setup_intent.succeeded`, server marks `partner.payment_method_attached_at`, upgrades the api_key row's `scope_state` from `readonly` to `full` in place, writes audit `partner.payment_method_attached`.
7. **Agent:** next `verify_tenant` poll returns `{ status: "active", api_key, scope: "full" }` (same key value). Agent continues with `configure_defaults`, `send_deployment_invites`, and polling `get_fleet_status` as devices come online.

### Failure modes

- **Token expired before click:** `verify_tenant` returns `{ status: "expired", remediation: "call create_tenant again with same email" }`.
- **Idempotent retry:** `create_tenant` within a 1h window with the same `admin_email + org_name` returns the existing `tenant_id` and re-sends the activation email. Beyond 1h, a retry creates a fresh partner.
- **Abandoned after email click, no payment:** partner sits in `pending_payment` indefinitely; readonly key keeps working. Background cron purges abandoned `pending_payment` partners after 30 days with no activity.
- **Stripe SetupIntent declined:** activation page shows a retry CTA; partner stays `pending_payment`; agent keeps polling harmlessly.
- **Agent disconnects mid-flow:** everything is resumable by `tenant_id` alone. That's the only piece of state the agent needs to retain.

## Email-invite pipeline (`send_deployment_invites`)

Reuses existing enrollment-key and installer-builder infrastructure. No new agent enrollment mechanism, just a new email layer.

Per-call flow:
1. **Gate checks:** payment method attached (else `PAYMENT_REQUIRED`), `emails.length ≤ min(25 free-tier cap, remaining_device_cap)`, per-email syntax validation (business-email blocklist is **not** applied to staff — BYOD personal addresses are legitimate), dedupe against invites in the last 24h to the same recipient.
2. **Per recipient:** mint a child enrollment key under the tenant's parent key (existing `enrollmentKeys.ts`), `max_usage=1`, `expires_at=now()+7 days`, metadata tagged with `{ invited_email, invited_by_actor, invite_id }`. Insert a `deployment_invites` row. Enqueue a transactional email job.
3. **Audit:** per-email event, `actor_type=api_key`, `initiated_by=integration`, event type `invite.sent`.

Email template (transactional, owner-brandable later):

```
Subject: [Acme IT] Install your device monitoring agent

Hi,

Your IT admin (alex@acme.com) has set up Breeze, a monitoring agent
that keeps your device secure and performant.

→ Install now: https://us.2breeze.app/i/<short_code>

The install takes <60 seconds and detects your OS automatically.
Mac, Windows, and Linux supported. Admin password will be required
on your machine.

Questions? Reply to this email.

— Breeze, for Acme IT
```

`custom_message` is injected as a second paragraph (HTML stripped, 500-char cap). `<short_code>` is the existing enrollment-key 8-char public redeem code; the landing page exchanges it for the real token server-side.

Landing page `/i/<short_code>` (extends the existing public-installer-link infra):
- Server-side OS detection from User-Agent.
- Exchanges short code for enrollment key via `installerBuilder`.
- Renders a single-page flow with a primary "Download for <detected OS>" button and secondary links for the others.
- Serves pre-built signed installers (existing MSI/PKG pipeline) with the enrollment token baked in.
- Marks `deployment_invite.clicked_at`; on first heartbeat from the enrolled device, matches `device.enrollmentKeyId → deployment_invite.id` and marks `enrolled_at + device_id`.

`get_fleet_status` returns, per tenant, the invite funnel counts and a `recent_enrollments[]` array with `device_id`, `hostname`, `os`, `invited_email`, `enrolled_at`. That's what the agent polls to report "3 of 5 devices online so far."

Email provider uses whatever Breeze already uses for transactional email. One new template, one new job queue entry type. No new external service.

## Abuse controls and security

### Rate limits (all backed by existing `services/rate-limit.ts`)

| Key pattern | Limit | Purpose |
|---|---|---|
| `mcp:bootstrap:ip:<ip>` | 3/hour | `create_tenant` per source IP |
| `mcp:bootstrap:domain:<email-domain>` | 5/day | `create_tenant` per email domain |
| `mcp:bootstrap:global` | 200/hour | `create_tenant` across the whole instance (blast-radius cap) |
| `mcp:verify:tenant:<id>` | 60/minute | `verify_tenant` polling |
| `mcp:activate:token:<hash>` | 10/hour | `/activate/:token` page hits (brute-force deterrent) |
| `mcp:invites:tenant:<id>` | 50/hour | `send_deployment_invites` per tenant |

The global bootstrap cap is the breakglass for coordinated abuse.

### Business-email validator

`packages/shared/src/validators/businessEmail.ts`:
- **Source 1:** `disposable-email-domains` npm package.
- **Source 2:** hand-curated free-provider list: gmail/googlemail, outlook/hotmail/live/msn, yahoo (+ country TLDs), icloud/me/mac, aol, proton/protonmail, tutanota/tuta, gmx, yandex, mail.ru, fastmail, zoho (personal), qq, 163, 126, naver, daum.
- Returns `{ ok: boolean, reason?: 'disposable' | 'free_provider' }`.
- Exported for optional reuse on the human signup path.
- **Override file:** `BUSINESS_EMAIL_ALLOW_OVERRIDES` env points to a JSON file with `{ "always_allow": [...], "always_block": [...] }` for self-hoster tuning.

### Payment gate

Explicit per-tool wrap (not tier-based auto-application):

```ts
export function requirePaymentMethod<T>(handler: ToolHandler<T>): ToolHandler<T> {
  return async (ctx, input) => {
    const partner = await getPartner(ctx.partnerId)
    if (!partner.paymentMethodAttachedAt) {
      throw new McpToolError('PAYMENT_REQUIRED', {
        message: 'This action requires a payment method on file (identity verification, no charge for free tier).',
        remediation: { tool: 'attach_payment_method', args: { tenant_id: ctx.partnerId } }
      })
    }
    return handler(ctx, input)
  }
}
```

Wrapped tools: `send_deployment_invites`, `configure_defaults`, `set_alert_policy`. Future tier-2+ tools opt in explicitly.

Readonly-scope backstop (in `mcpServer.ts`, after auth, before dispatch): if `apiKey.scope_state === 'readonly'` and `toolTier(tool) >= 2`, return the same `PAYMENT_REQUIRED` error shape. Defense in depth.

### API key scoping and revocation

- Minted keys are normal `api_keys` rows with `scope_state` initially `readonly`, upgraded in place to `full` on payment-attach.
- Visible in the web UI at `/partner/settings/api-keys` with a `Source: MCP Provisioning` label. Admin can revoke or narrow scope at any time.
- Rotatable via the existing key-rotation flow.

### Audit logging

New audit event types, landing in the existing stream (surfaced in `get_recent_activity`):
- `partner.mcp_provisioned`
- `partner.activation_completed`
- `partner.payment_method_attached`
- `invite.sent`, `invite.clicked`, `invite.enrolled`

Metadata on every bootstrap-tool audit event: `mcp_origin=true`, `tool_name`, `input_digest` (SHA-256 of canonicalized inputs — auditable without leaking full payloads).

### Risk engine

Preserved unchanged. All authed tool dispatch still flows through the existing tier system and risk-engine gate. MCP bootstrap adds new *entry points*, never new *execution paths*.

### Tenant isolation

- New partners go through the existing `/register-partner` transaction, inheriting every RLS policy automatically.
- `partner_activations` is partner-axis RLS (shape 3), in `PARTNER_TENANT_TABLES`, verified by `rls-coverage.integration.test.ts` in the same PR.
- Bootstrap handlers run under `withSystemDbAccessContext`; all DB writes are scoped to the `tenant_id` being created/polled, verified by targeted integration tests.
- Per CLAUDE.md, a cross-tenant forge check is run as `breeze_app`: tenant A forges insert into tenant B's `partner_activations` → must fail with `new row violates row-level security policy`.

## Testing

### Unit / route (Vitest + Drizzle mocks)
- `mcpBootstrap/createTenant.test.ts` — happy path, duplicate within 1h (idempotent), business-email blocklist, disposable-email blocklist, rate-limit exhaustion (per-IP, per-domain, global), region-endpoint mismatch.
- `mcpBootstrap/verifyTenant.test.ts` — all four state transitions, key scope in response matches partner state, polling rate-limit.
- `mcpBootstrap/attachPaymentMethod.test.ts` — SetupIntent URL returned, billing service unreachable, idempotent if card already attached.
- `mcpBootstrap/paymentGate.test.ts` — decorator blocks when `payment_method_attached_at IS NULL`, passes through when set, error shape includes remediation breadcrumb.
- `mcpBootstrap/businessEmail.test.ts` — exhaustive provider table, override file honored, IDNA/Unicode domain normalization.
- `sendDeploymentInvites.test.ts` — child key minting, email jobs enqueued, 24h dedupe, per-tenant rate-limit, payment gate, free-tier cap, short-code landing page.
- `mcpServer.test.ts` additions — `tools/list` returns bootstrap-only when unauth'd + flag on, full when authed, 401 when unauth'd + flag off.

### Integration (real Postgres)
- `mcpBootstrap.integration.test.ts` — full flow: create → poll → simulated email click → poll → simulated Stripe webhook → poll → authed tool call succeeds.
- `rls-coverage.integration.test.ts` — `partner_activations` added to allowlist; contract test verifies policies.
- Cross-tenant forge test as `breeze_app`.

### E2E (YAML runner)
`e2e-tests/tests/mcp_bootstrap.yaml`: simulated agent drives the full flow via the MCP HTTP endpoint. Email-click and Stripe steps stubbed via test hooks (`MCP_BOOTSTRAP_TEST_MODE=true` accepts `/test/activate/:token` and `/test/complete-payment/:partner_id` that bypass real email/Stripe round-trips). Asserts tenant created, key scope transitions, invite emails queued, fleet status populates after simulated heartbeats.

### Go agent
No changes. Existing `public-installer-link` flow handles email-invite enrollment.

### Manual demo rehearsal
Scripted dry run of the full narrative with a real admin email + real Stripe test card + two real devices (Mac + Windows). This is the "can we film the video" gate.

### Observability
OpenTelemetry spans on the three bootstrap tools (mostly free from existing MCP server instrumentation). One new metric `mcp_bootstrap_activations_total{status}` to watch funnel drop-off on Breeze Cloud.

## v1 scope (single implementation plan)

| Item | Notes |
|---|---|
| Feature-flagged module `apps/api/src/modules/mcpBootstrap/` | `MCP_BOOTSTRAP_ENABLED` default false, dynamic import on flag |
| Three bootstrap tools + auth carve-out in `mcpServer.ts` | `create_tenant`, `verify_tenant`, `attach_payment_method` |
| `partner_activations` table + `partners`/`api_keys` column additions | One idempotent migration |
| Activation page at `/activate/:token` + `/activate/complete` | Reuses `breeze-billing` for Stripe SetupIntent |
| `send_deployment_invites` + landing page extension (`/i/:short_code`) | Extends existing public-installer-link infra |
| `configure_defaults` opinionated-baseline wrapper | One-call all-or-nothing |
| Business-email validator in `packages/shared` | Exported, not flag-gated |
| `delete_tenant` tier-3+ authed tool with typed confirmation | Flag-independent |
| `PAYMENT_REQUIRED` error + remediation breadcrumbs in tool descriptions | The prose that makes the agent recover autonomously |
| Rate limits + audit event types + RLS policies + full test pack | Per above |
| Web UI label for MCP-sourced API keys | One-line label in settings/api-keys page |
| Startup hard-check for required envs when flag is on | `STRIPE_SECRET_KEY`, `BREEZE_BILLING_URL`, `EMAIL_PROVIDER_KEY`, `PUBLIC_ACTIVATION_BASE_URL` |

## v2 (separate spec, not now)

- Server-side first-run AI health assessment (event hook on `device.first_seen` → BullMQ job → persisted findings tool, e.g. `get_first_run_findings(tenant_id)`).
- Invite resend / cancel tools (`resend_invite`, `cancel_invite`).
- Custom email branding / per-tenant templates.
- Paid-plan upgrade flow beyond free (plan-change tool, device cap expansion).
- SMS / Slack / Teams invite channels.
- Teardown restore tool for the 30-day soft-delete window.

## Risk register

1. **Stripe SetupIntent cross-tab handoff.** The "return to your agent chat" step is cross-tab; must work even if the agent has timed out its polling loop. Mitigation: `verify_tenant` always returns current state — no reliance on real-time signals; agent resumes by polling `tenant_id` alone.
2. **Email deliverability.** Business-email-only pushes traffic to corporate domains where greylisting and SPF/DKIM strictness are higher. Working DMARC on `2breeze.app` is required before launch.
3. **Short-code collision at scale.** Existing infra handles this, but a contract test at free-tier scale (25 invites × many tenants) is worth adding.
4. **Idempotent `create_tenant` window.** 1h dedupe by `admin_email + org_name` — two humans at the same company with different admin emails on the same day get separate tenants. Likely fine; flagged here so it isn't surprising later.
5. **Self-hoster accidentally enables without required envs.** Mitigated by the hard startup check; worth an explicit README note in the module directory.

## Success criteria

- An AI agent with no prior Breeze context can, via MCP only, go from zero to a monitored fleet with health findings.
- The flow works reliably enough to demo live without rehearsal surgery.
- The tenant created via agent is a real tenant that persists and can be managed normally via the web UI afterward.
- Total agent-driven setup time is under 5 minutes from first tool call to first useful output.
- Self-hosted Breeze installs with `MCP_BOOTSTRAP_ENABLED` unset show zero new behavior and zero new unauthenticated attack surface.
