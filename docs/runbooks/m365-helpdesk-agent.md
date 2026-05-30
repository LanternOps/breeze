# Breeze M365 Helpdesk Agent Operator Runbook

This runbook documents how to configure and seed the Breeze AI agent's Microsoft 365 helpdesk integration, which delegates identity and access operations to the Delegant service.

## Overview

The Breeze AI agent integrates five M365 helpdesk tools with the Delegant identity-governance service:
- `m365_lookup_user` — read user details
- `m365_recent_signins` — list recent sign-ins
- `m365_list_group_memberships` — enumerate group membership
- `m365_disable_user` — disable a user account (mutation)
- `m365_reset_password` — reset a user password (mutation)

These tools call Delegant via `POST /v1/tools/invoke`. Tier-1 reads (lookup, signins, groups) run automatically; tier-3 mutations (disable, reset) require approval via Breeze's approval UI.

---

## Section 1: Environment Variables

Configure these in `apps/api/src/config/env.ts` before deploying:

### Required Environment Variables

- **`DELEGANT_BASE_URL`** — base URL of the Delegant service (e.g. `https://delegant.internal`). No trailing slash.

- **`DELEGANT_SERVICE_TOKEN`** — the shared service bearer token; sent as `Authorization: Bearer <token>` to Delegant. Must match Delegant's configured `serviceToken`.

- **`DELEGANT_PRINCIPAL_SIGNING_KEY`** — an Ed25519 PRIVATE key in PKCS8 PEM format. Used to sign the per-call principal JWT. Delegant must hold the matching PUBLIC key (as a JWK in its `jwtKeySet`) under the same `kid`.

- **`DELEGANT_PRINCIPAL_KID`** — the key id; must match the `kid` of the public key registered in Delegant's `jwtKeySet`.

- **`DELEGANT_AGENT_ID`** — (v1 single-customer seeding) the Delegant `principals` row id of the `breeze_ai_agent` principal. Used as the JWT `sub` claim.

- **`DELEGANT_ACTING_USER_ID`** — (v1 single-customer seeding) the Delegant `principals` row id (a UUID) of the `breeze_user` principal representing the acting technician. Used as the JWT `breeze_acting_user_id` claim (chains the agent to the acting user).

### Single-Customer Shortcut (v1)

The current version uses `DELEGANT_AGENT_ID` and `DELEGANT_ACTING_USER_ID` as a **single-customer shortcut**. This is because v1 lacks a per-technician principal mapping table — a known follow-up. Bulk principal provisioning is deferred to a Delegant-side slice.

Example configuration:
```bash
export DELEGANT_BASE_URL="https://delegant.internal"
export DELEGANT_SERVICE_TOKEN="shared-service-token-here"
export DELEGANT_PRINCIPAL_SIGNING_KEY="-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----"
export DELEGANT_PRINCIPAL_KID="key-id-matching-public-in-delegant-jwtkeyset"
export DELEGANT_AGENT_ID="breeze-ai-agent-principals-id"
export DELEGANT_ACTING_USER_ID="breeze-user-principals-id-uuid"
```

---

## Section 2: Delegant-Side Prerequisites

Before Breeze can invoke helpdesk tools, an operator **must** set up the following in Delegant:

### 1. Create the Agent Principal

Create a `breeze_ai_agent` principal in Delegant. Record its `principals` row id → `DELEGANT_AGENT_ID`.

### 2. Create a Technician Principal

Create a `breeze_user` principal per technician in Delegant. Record its id (a UUID) → `DELEGANT_ACTING_USER_ID`. The principal **must**:
- Belong to the **same Delegant org** as the M365 connection being onboarded.
- Have type `breeze_user` (Delegant's wireAuth rejects mismatches with 403).

### 3. Configure Policy

Ensure the org's Delegant policy permits `breeze_ai_agent` to invoke the relevant tools as `allow` (NOT `require_approval`):

```
breeze_ai_agent {
  m365_lookup_user: allow
  m365_recent_signins: allow
  m365_list_group_memberships: allow
  m365_disable_user: allow
  m365_reset_password: allow
}
```

If a tool resolves to `require_approval` or `pending` on the Delegant side, Breeze returns a fail-loud `unexpected_pending` error — because Breeze owns the human approval step, not Delegant. (See Troubleshooting for details.)

### 4. Register the JWT Public Key

Register the JWT public key (matching `DELEGANT_PRINCIPAL_KID`) in Delegant's `jwtKeySet`. Delegant uses this key to verify the per-call principal JWT signed by Breeze.

---

## Section 3: Seed the Breeze-Side Connection (SQL)

There is **no onboarding UI in v1**; seed the connection manually with a single SQL INSERT.

**Note:** The `delegant_m365_connections` table has RLS enabled via `breeze_has_org_access`. Run this as a DB superuser/owner or with the appropriate role that bypasses RLS (e.g., the migration/admin role).

```sql
INSERT INTO delegant_m365_connections
  (org_id, customer_label, customer_display_name, delegant_org_id, delegant_connection_id, m365_tenant_id, status)
VALUES
  ('<breeze-org-uuid>', 'sandbox', 'Sandbox Tenant',
   '<delegant-org-id>', '<delegant-connection-id>', '<m365-tenant-id>', 'active');
```

### Placeholder Definitions

- **`breeze-org-uuid`** — the Breeze organization (MSP partner) UUID.
- **`sandbox`** — the slug a technician picks in the session switcher.
- **`Sandbox Tenant`** — shown in the customer switcher and on approval cards.
- **`delegant-org-id`** — the Delegant org id that owns this M365 connection.
- **`delegant-connection-id`** — the Delegant connection id (points to the M365 credential pair onboarded in Delegant).
- **`m365-tenant-id`** — the customer's Microsoft 365 tenant id (display only; no secrets stored Breeze-side).
- **`active`** — status; valid values are `active`, `paused`, or `deactivated`.

### Security Note

**No secrets are stored Breeze-side.** The per-customer Entra client secret lives in Delegant. Breeze only stores the pointer (`delegant_connection_id`) and references it during tool invocation.

---

## Section 4: Technician Workflow

1. **Open the Breeze AI chat** — the technician navigates to the agent in the Breeze app.

2. **Pick the customer** — a new session-switcher dropdown appears. The technician selects the customer (e.g., "Sandbox Tenant").

3. **Ask the agent for helpdesk work** — the technician makes a natural-language request (e.g., "Look up user john@contoso.com", "Reset password for jane@contoso.com").

4. **Automatic tier-1 reads** — lookup, signins, and group-membership calls execute automatically and return results inline.

5. **Approve tier-3 mutations** — if the agent needs to disable a user or reset a password, Breeze's approval UI (web or mobile) shows an approval card with:
   - Customer tenant name
   - Target user
   - Requested action (disable / reset password)
   - Reason (from the agent's context)
   
   The technician approves or rejects. On approval, Breeze calls Delegant's tool-invoke endpoint.

---

## Section 5: Database Migrations Note (Operational Gotcha)

The package script `pnpm --filter @breeze/api db:migrate` runs `tsx src/db/autoMigrate.ts`, but **that file only DEFINES `autoMigrate()` without invoking it** (no main-guard). **As a result, `db:migrate` is effectively a NO-OP.**

### Where Migrations Actually Run

Migrations are applied by `apps/api/scripts/check-migrations.ts`, which:
- Calls `autoMigrate()`
- Is run during deployment or container startup
- Requires the `breeze_app` DB role to exist

The `breeze_app` role is provisioned by `ensureAppRole()` when both of these are set:
- `POSTGRES_PASSWORD` or `BREEZE_APP_DB_PASSWORD`
- `DATABASE_URL_APP`

### M365 Migrations

The two M365-specific migrations are:
- `2026-05-27-b-delegant-m365-connections.sql` — creates the `delegant_m365_connections` table with RLS.
- `2026-05-27-c-ai-sessions-delegant-connection.sql` — adds `delegant_connection_id` to the `ai_sessions` table.

**Operators should be aware:** this is a pre-existing repo quirk. Do not assume `pnpm db:migrate` has applied all pending migrations; verify by querying the schema or checking `_migrations` table.

---

## Section 6: Forensic / Audit Correlation

A complete audit trail spans both Breeze and Delegant:

1. **Breeze side:** Locate the `ai_tool_executions` row for the execution (filtered by technician, time, tool name, etc.).

2. **Extract `delegant_tool_call_id`** — this column contains the call id returned by Delegant's invoke response.

3. **Query Delegant audit:**
   ```
   GET /v1/audit/tool-calls/{delegant_tool_call_id}
   ```
   
4. **Delegant's response** shows the complete ledger entry:
   - Agent principal (`breeze_ai_agent`) attribution
   - Acting-user principal attribution (the technician)
   - Tool name and parameters
   - Result/outcome
   - Hash-chained record integrity

This cross-service correlation enables operators to reconstruct the full authorization and execution chain for any helpdesk action.

---

## Section 7: Prerequisites for Live / Manual Testing

A **disposable Microsoft 365 SANDBOX tenant** is required for:
- The live test suite (`test/live/m365-*.live.test.ts`)
- Manual end-to-end verification

### Why Sandbox is Mandatory

Mutations like password reset and user disable **hit a real M365 tenant**. Never run mutation tests against a production customer tenant.

### Setup Steps

1. Provision a test M365 sandbox tenant (Microsoft provides free developer tenants).
2. Onboard the sandbox M365 credentials in Delegant (creating a `delegant_connection_id`).
3. Create the `breeze_user` principal in Delegant for the test technician.
4. Seed the Breeze `delegant_m365_connections` table (Section 3) with the sandbox connection.
5. Set all required environment variables (Section 1).
6. Run the live test suite:
   ```bash
   pnpm --filter @breeze/api test:live
   ```

---

## Troubleshooting

### `unexpected_pending` Error

**Symptom:** Tool invocation returns "Tool returned unexpected_pending."

**Cause:** Delegant evaluated the policy as `require_approval` or `pending` for this tool. Breeze does not support deferred approval on the Delegant side.

**Resolution:**
1. Check the org policy in Delegant for the `breeze_ai_agent` principal.
2. Ensure the tool is set to `allow` (not `require_approval`).
3. Redeploy or reload Delegant's policy cache.

### JWT Signature Verification Fails

**Symptom:** Delegant returns 401 Unauthorized on tool invocation.

**Cause:** The signing key or `kid` mismatch between Breeze and Delegant.

**Resolution:**
1. Verify `DELEGANT_PRINCIPAL_SIGNING_KEY` is the correct Ed25519 private key in PKCS8 PEM format.
2. Extract the corresponding public key and register it in Delegant's `jwtKeySet` with the exact same `kid` as `DELEGANT_PRINCIPAL_KID`.
3. Test signature with a tool like `openssl` or the Delegant validation endpoint.

### Service Token Rejected

**Symptom:** Delegant returns 403 Forbidden with "invalid service token."

**Cause:** `DELEGANT_SERVICE_TOKEN` does not match Delegant's configured `serviceToken`.

**Resolution:**
1. Confirm the token value in both systems.
2. Verify there are no leading/trailing whitespaces in the env var.
3. Redeploy Breeze after updating the token.

### Migration Table Not Found

**Symptom:** Breeze API fails at startup with "table delegant_m365_connections does not exist."

**Cause:** Migrations did not run during deployment.

**Resolution:**
1. Verify `DATABASE_URL_APP` and `BREEZE_APP_DB_PASSWORD` (or `POSTGRES_PASSWORD`) are set.
2. Check `_migrations` table for the two M365 migration entries (2026-05-27-b-*, 2026-05-27-c-*).
3. If missing, manually run `check-migrations.ts` or trigger the deployment pipeline again.
4. See Section 5 for more context on migration execution.

---

## Summary Checklist

Before going live:

- [ ] All environment variables set (Section 1)
- [ ] `breeze_ai_agent` principal created in Delegant (Section 2.1)
- [ ] `breeze_user` principal created in Delegant, same org, type `breeze_user` (Section 2.2)
- [ ] Policy configured for `allow` on all five tools (Section 2.3)
- [ ] JWT public key registered in Delegant's `jwtKeySet` with correct `kid` (Section 2.4)
- [ ] `delegant_m365_connections` row seeded via SQL (Section 3)
- [ ] Migrations applied (`_migrations` table contains 2026-05-27-b-* and 2026-05-27-c-*) (Section 5)
- [ ] Sandbox M365 tenant available for testing (Section 7)
- [ ] Technician `breeze_user` principal linked in `DELEGANT_ACTING_USER_ID`

For live troubleshooting, use the audit trail in Section 6 to correlate actions across Breeze and Delegant.
