# MCP Bootstrap Module

Feature-flagged module that lets an external AI agent provision a brand-new
Breeze tenant end-to-end via MCP. Default OFF.

**This module is for Breeze Cloud only.** Self-hosted deployments should
leave `IS_HOSTED` unset.

## Required environment variables (when enabled)

| Var | Purpose |
|---|---|
| `IS_HOSTED` | Set to `true` to enable. Default `false`. |
| `STRIPE_SECRET_KEY` | Stripe secret for SetupIntent creation via breeze-billing. |
| `BILLING_URL` | Public URL of the breeze-billing payment-setup landing page. Empty on self-host. Used by the OAuth consent handler to redirect users with `partner.status != 'active'`. |
| `BREEZE_BILLING_URL` | Internal service-to-service base URL of the breeze-billing service (used by `breezeBillingClient.ts`). |
| `EMAIL_PROVIDER_KEY` | Whichever email provider is configured globally. |
| `PUBLIC_ACTIVATION_BASE_URL` | e.g. `https://us.2breeze.app`. |
| `BUSINESS_EMAIL_ALLOW_OVERRIDES` | Optional. Path to JSON file. |

## What gets registered when enabled

- MCP bootstrap tools: `create_tenant`, `verify_tenant`, `attach_payment_method` (unauthenticated).
- Authed MCP tools: `send_deployment_invites`, `configure_defaults`.
- Routes: `/activate/:token`, `/activate/complete/webhook`, `/i/:short_code`.
- `PAYMENT_REQUIRED` gate on the mutating authed tools + `set_alert_policy`.

## Bootstrap secret contract

`create_tenant` returns both `tenant_id` and `bootstrap_secret`. The secret is
shown only once and only its SHA-256 hash is stored in `partners.settings`.
Unauthenticated follow-on tools must pass both values:

- `verify_tenant({ tenant_id, bootstrap_secret })`
- `attach_payment_method({ tenant_id, bootstrap_secret })`

This keeps `tenant_id` as a locator, not a bearer authorization secret.

## Flag-independent (always on)

- `delete_tenant` authed MCP tool.
- `validateBusinessEmail` shared validator.

See spec: `docs/superpowers/specs/2026-04-20-mcp-agent-deployable-setup-design.md`.
