# MCP Bootstrap — Demo Rehearsal Runbook

Date: 2026-04-20 (authored at plan/feature creation)
Related spec: `docs/superpowers/specs/2026-04-20-mcp-agent-deployable-setup-design.md`
Related plan: `docs/superpowers/plans/2026-04-20-mcp-agent-deployable-setup.md`
Feature branch: `feature/mcp-bootstrap`

## What this rehearses

Full agent-driven tenant provisioning flow end-to-end on Breeze Cloud staging. Target: under 5 minutes wall-clock from first agent tool call to "X devices online, here's what I found."

## Prerequisites

Environment:
- Breeze Cloud staging instance (US or EU) with:
  - `MCP_BOOTSTRAP_ENABLED=true`
  - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` set to test-mode values
  - `BREEZE_BILLING_URL` pointing at breeze-billing (Stripe test mode)
  - `EMAIL_PROVIDER_KEY` set with a working transactional email provider
  - `PUBLIC_ACTIVATION_BASE_URL` (e.g. `https://staging-us.2breeze.app`)
  - `BREEZE_REGION=us` (or eu)
- Stripe webhook endpoint registered at `/activate/complete/webhook` with the test-mode signing secret
- breeze-billing endpoint `POST /setup-intents` live and functioning

Physical/accounts:
- Real inbox for the admin email you'll use (business domain required — no gmail/outlook etc.)
- Stripe test card: `4242 4242 4242 4242`, any future date, any CVC, any ZIP
- One Mac + one Windows device ready for install (VM or physical)
- Claude.ai (or another MCP-capable agent) account

## Pre-flight checks

Run these before the rehearsal:
- [ ] `curl https://staging-us.2breeze.app/health` returns OK.
- [ ] `curl -X POST https://staging-us.2breeze.app/mcp/message -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` returns exactly three tools: `create_tenant`, `verify_tenant`, `attach_payment_method`. (Proves flag is on and carve-out works.)
- [ ] Stripe webhook receiver is live (`GET /activate/complete/webhook` returns 405 — route exists, wrong method).
- [ ] A test send from the email provider reaches your inbox.

## Steps

### 1. Connect MCP to Claude

- In Claude.ai, add an MCP connector pointing at `https://staging-us.2breeze.app/mcp/message` (no auth header — the bootstrap carve-out handles unauth).
- Verify Claude lists the three bootstrap tools.

### 2. Prompt the agent

Paste (adapted to your inbox):
> "Set up Breeze RMM for Acme Corp. The admin email is <YOUR_EMAIL@yourcompany.com>. Once it's running, send install invites to <EMAIL1> and <EMAIL2>."

Expected agent actions (observe in Claude's tool-call log):
1. `create_tenant` — returns `{ tenant_id, activation_status: 'pending_email' }`.
2. Several `verify_tenant` polls returning `pending_email`.
3. Agent pauses, asks you to click the activation email.

### 3. Click the activation email

- Open the email (subject: "Activate your Breeze tenant for Acme Corp").
- Click the link. Lands on `/activate/<token>?status=email_verified` with a "Add payment method" button.
- Click the button. Redirected to Stripe Checkout (mode=setup).
- Enter test card `4242 4242 4242 4242`, future date, any CVC, any ZIP.
- Complete. Redirected to `/activate/complete`.
- Return to Claude tab.

### 4. Agent resumes

Expected:
1. Next `verify_tenant` poll returns `status: pending_payment` (happens on email click, before Stripe completes).
2. Agent calls something and gets `PAYMENT_REQUIRED` with a remediation breadcrumb.
3. Agent calls `attach_payment_method` and pauses for the human (but you've already done Stripe — so the next `verify_tenant` returns `active`).
4. Agent proceeds: `configure_defaults` (applies baseline) + `send_deployment_invites` (sends emails to EMAIL1, EMAIL2).
5. Agent reports: "Your tenant is set up and I've invited 2 staff. Polling for enrollments…"

### 5. Install on the two devices

- Open the invite emails on each target device.
- Click the install link. Landing page auto-detects OS, shows the right installer.
- Run the installer (admin password required on the target machine).
- Wait for first heartbeat (typically < 30s).

### 6. Agent reports findings

Expected agent output after polling `get_fleet_status` a few times:
- "2 of 2 devices online. 1 has pending patches. Here's the health report…" (or similar, depending on `get_fleet_health` output).

## Timing target

From prompt paste (step 2) to the final agent report (step 6):

- **Under 5 minutes wall-clock** if install on both devices is done in parallel and the user acts on the email/Stripe prompts within 60s each.
- Budget: 30s create_tenant → email wait → 30s to click email → 60s to complete Stripe → 30s for send_deployment_invites → 60-90s install × 2 (parallel) → 30s polling → first findings. Total: ~4-4.5 min under clean conditions.

## Rollback / tear-down

If a step fails catastrophically mid-demo:

1. Ask the agent to call `delete_tenant(tenant_id, confirmation_phrase="delete acme corp permanently")` — this soft-deletes with a 30-day restore window.
2. If the tool is unavailable (e.g. agent lost auth state), manually mark the partner deleted:
   ```sql
   UPDATE partners SET deleted_at = now(), status = 'churned' WHERE id = '<tenant_id>';
   ```
3. Restart the rehearsal with a fresh admin email (or wait 1h for the idempotency window to clear).

## Known failure modes to watch for

- **Business-email rejection**: Using `alex@gmail.com` returns `INVALID_EMAIL` with `reason: 'free_provider'`. Use a real business domain.
- **Rate limit**: 3 `create_tenant` calls per IP per hour, 5 per email domain per day. Don't do >2 rehearsals from the same IP back-to-back.
- **breeze-billing `POST /setup-intents` down**: `attach_payment_method` returns `BILLING_UNAVAILABLE`. Check the billing service logs.
- **Stripe webhook signature mismatch**: `setup_intent.succeeded` is rejected with 400 but the `partners.payment_method_attached_at` never flips, so `verify_tenant` stays on `pending_payment`. Usually a webhook secret mismatch.
- **Email delivery delay**: If the activation email doesn't arrive within 2 min, check the provider's logs AND whether the admin email's domain has strict DMARC/SPF. Business domains sometimes greylist transactional senders.
- **Installer landing page reports "invalid or already used"**: The child enrollment key was already redeemed. Trigger a fresh invite.

## Where to find things during the rehearsal

- **Agent tool-call log**: Claude.ai right-pane.
- **Server logs**: `docker logs breeze-api -f` on the staging host (if docker) or the usual observability stack.
- **Audit trail**: authed MCP call to `query_audit_log` with `action: 'partner.mcp_provisioned'` (or similar) returns the events.
- **Funnel metrics**: `mcp_bootstrap_activations_total{status=...}` counter at the Prometheus scrape endpoint.

## After the rehearsal

- Save the tenant (it's a real tenant) or tear down via `delete_tenant`. Don't leave orphans in staging.
- Note any surprises or timing outliers — file a follow-up task.
- If this is a filmed demo, the 5-min mark is what goes in the demo video.
