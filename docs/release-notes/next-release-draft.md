# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.125.0** (2026-10-27).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

## Self-Hosting / Upgrade Notes (fold into the release body)

## Features / API

## Migrations

### Flows W05 (#5215 / #5220, PR D — web, limits and egress audit)

Behind `FLOWS_ENABLED` (default off). No new environment variables.

- **Webhook tab on a webhook flow.** Shows the URL, the authentication mode and how to sign a request, the secret's fingerprint and the reason of the last refused request. **Create secret** / **Rotate secret** (rotation asks first: the old secret stops working at once) shows the new secret once. When enabling a new version clears the secret, the page says so. The tab lists recent deliveries with their status, organization, run link and attempts; users limited to some sites or devices are told the delivery id and organization value are hidden.
- **Run limits are visible and configurable.** The flow page shows this month's runs against the flow and owner caps, and a banner when runs are being refused (the flow stays enabled); the flow list badges such flows. New page **Settings → Flow limits** (`/settings/flow-limits`) sets the partner default (needs `automations.write`, MFA and full partner organization access) and an organization override that can only lower it. New routes `GET /api/v1/flows/limits[?orgId=]` and `PUT /api/v1/flows/limits` (`{ orgId?, limits: { monthlyRunsPerOwner?, monthlyRunsPerFlow?, aiTokensPerRun? } }`, `null` clears a value); a raise above the partner value is refused with `422 limit_above_partner_ceiling`. The organization and partner settings editors no longer change `settings.flows`.
- **Steps and runs:** the step list describes `notify`, `http_request` and `ai` steps; the run timeline groups for-each items that ran in parallel and shows an `ai` step's tokens and cost, an `http_request` step's HTTP status, and the agent run that started a flow. The AI agent tool picker lists enabled manual flows as `flow__<slug>` tools.
- **`ai` step calls are now in the LLM egress audit** (surface `flow_ai_step`) when the organization's model runs on a partner catalog endpoint.
- `GET /api/v1/flows` rows now carry `lastAdmissionRefusal`; `GET /api/v1/flows/:id/webhook-deliveries` adds `identifiersHidden`.
- **Migration** `2027-01-08-140000-flow-ai-step-egress-surface.sql`: re-issues the `llm_egress_events_surface_chk` CHECK with `flow_ai_step` added; DDL only, no backfill. Re-adding the CHECK scans `llm_egress_events` once to validate existing rows (no rewrite).

### On-device dialogs (#10190)

- **One MSP identity for device prompts.** The server now resolves, in one place, the name, colour and logo a device's prompts are drawn under: the partner name (sanitized; an organization can never change it), with the colour and logo from Settings → Partner → Branding and the organization's portal branding winning where one is set. Agents that report `securityCapabilities.promptIdentityProtocolVersion: 1` receive it as a new heartbeat block, `promptIdentity` (no shipped agent reports it yet), and download the logo from the new agent-authenticated `GET /api/v1/agents/:id/prompt-identity/logo?sha256=<hex>`. Only PNG, JPEG or WebP logos of at most 256 KB and 1024 px per side are used; SVG and anything else mean no logo. An `https://` logo is fetched once by the server through the SSRF guard and cached; the device never fetches a URL. Endpoint-message sender cards use the same resolver: unchanged for partners without an organization portal colour, and an organization's portal colour now sets the accent.
- **The caller-verification card now shows the Partner → Branding logo** (or the organization's portal branding logo where one is set) instead of the partner's login-page logo. Only an `https://` logo is shown there; an uploaded logo is not sent to the card yet. No migration, no new environment variables.
