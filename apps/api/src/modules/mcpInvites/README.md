# mcpInvites

Authenticated MCP tools and HTTP routes that support agent-driven device deployment:

- `send_deployment_invites` — MCP tool that emails install links to a list of staff
- `configure_defaults` — MCP tool that applies a baseline of policies to a fresh tenant
- `inviteLandingRoutes` — HTTP `/install/<token>` landing page that auto-detects OS and serves the right installer
- `matchInviteOnEnrollment` — service that flips `deployment_invites.status` to `enrolled` on first heartbeat
- `metrics` — funnel counters for invite → click → enrolled

This module was previously named `mcpBootstrap`. The bootstrap-specific tools (`create_tenant`, `verify_tenant`, `attach_payment_method`) and the `/activate/<token>` flow were removed in 2026-04-29 — see `docs/superpowers/plans/2026-04-29-mcp-bootstrap-cleanup.md`.

## Required environment variables (when enabled)

| Variable | Purpose |
|---|---|
| `IS_HOSTED` | Set `true` for hosted SaaS deployments. New partners land at `status='pending'` until billing flips them to `'active'`. |
| `BILLING_URL` | Public URL of the breeze-billing payment-setup landing page. Empty on self-host. Used by the OAuth consent handler to redirect users with `partner.status != 'active'`. |
| `BREEZE_BILLING_URL` | Internal service-to-service base URL of the breeze-billing service (used by `breezeBillingClient.ts`). |
| `EMAIL_PROVIDER_KEY` | Whichever email provider is configured globally. |
