# Cloudflare mTLS Client Certificate Setup

This guide covers enabling Cloudflare API Shield mTLS for Breeze RMM agents. mTLS adds proof-of-possession security at the TLS layer — agents must present a valid client certificate before any request reaches the API. The existing bearer token remains as the application-layer identity check.

**This feature is fully optional.** No existing behavior changes unless you explicitly enable it.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Phase 1: Deploy Code](#phase-1-deploy-code)
3. [Phase 2: Configure Cloudflare Credentials](#phase-2-configure-cloudflare-credentials)
4. [Phase 3: Run Database Migration](#phase-3-run-database-migration)
5. [Phase 4: Verify Agent Enrollment](#phase-4-verify-agent-enrollment)
6. [Phase 5: Enable WAF Enforcement](#phase-5-enable-waf-enforcement)
7. [Org-Level Settings](#org-level-settings)
8. [Admin Quarantine Management](#admin-quarantine-management)
9. [Certificate Lifecycle](#certificate-lifecycle)
10. [Troubleshooting](#troubleshooting)
11. [API Reference](#api-reference)

---

## Prerequisites

- Breeze RMM API and agents updated to the version containing the mTLS feature
- A Cloudflare account with the domain proxied through Cloudflare
- Cloudflare API Shield entitlement (available on Business and Enterprise plans)
- PostgreSQL database accessible for migrations

---

## Phase 1: Deploy Code

Deploy the updated API and agent binaries. At this stage:

- No environment variables are set, so mTLS is completely inactive
- Enrollment returns `mtls: null` in the response
- Agents behave exactly as before (bearer-token-only auth)
- **Zero behavior change from the previous version**

---

## Phase 2: Configure Cloudflare Credentials

### 2a. Create a Cloudflare API Token

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) > My Profile > API Tokens
2. Click **Create Token**
3. Use the **Custom Token** template with these permissions:
   - **Zone > SSL and Certificates > Edit**
4. Scope it to the specific zone where your API is hosted
5. Copy the generated token

### 2b. Find Your Zone ID

1. Go to your domain's **Overview** page in the Cloudflare dashboard
2. The **Zone ID** is in the right sidebar under "API"

### 2c. Set Environment Variables

Add to your API server environment (`.env`, Docker, systemd, etc.):

```bash
CLOUDFLARE_API_TOKEN=your-cloudflare-api-token-here
CLOUDFLARE_ZONE_ID=your-zone-id-here
```

After setting these and restarting the API:

- New enrollments will receive an mTLS client certificate
- Existing agents continue working with bearer-token-only auth
- **mTLS is NOT enforced yet** — agents with certificates present them, but Cloudflare doesn't require them

---

## Phase 3: Run Database Migration

### Option A: Direct SQL

Connect to your PostgreSQL instance and run the statements in order:

```sql
-- Step 1: Run OUTSIDE a transaction (PostgreSQL limitation)
ALTER TYPE device_status ADD VALUE IF NOT EXISTS 'quarantined';

-- Step 2: Run in a transaction
BEGIN;

ALTER TABLE devices ADD COLUMN IF NOT EXISTS mtls_cert_serial_number varchar(128);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mtls_cert_expires_at timestamp;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mtls_cert_issued_at timestamp;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mtls_cert_cf_id varchar(128);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS quarantined_at timestamp;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS quarantined_reason varchar(255);

CREATE INDEX IF NOT EXISTS devices_mtls_cert_expires_idx
  ON devices (mtls_cert_expires_at)
  WHERE mtls_cert_expires_at IS NOT NULL AND status NOT IN ('decommissioned');

CREATE INDEX IF NOT EXISTS devices_quarantined_idx
  ON devices (org_id, status)
  WHERE status = 'quarantined';

COMMIT;
```

### Option B: Docker

```bash
# Add enum value (must be outside transaction)
docker exec <postgres-container> psql -U breeze -d breeze \
  -c "ALTER TYPE device_status ADD VALUE IF NOT EXISTS 'quarantined';"

# Add columns and indexes
docker exec <postgres-container> psql -U breeze -d breeze -f \
  /path/to/2026-02-11-mtls-cert-management.sql
```

### Option C: Drizzle Push (development only)

```bash
DATABASE_URL=postgresql://breeze:password@localhost:5432/breeze pnpm db:push
```

### Verify Migration

```sql
-- Check enum values
SELECT unnest(enum_range(NULL::device_status));
-- Should include: online, offline, maintenance, decommissioned, quarantined

-- Check columns exist
SELECT column_name FROM information_schema.columns
WHERE table_name = 'devices' AND column_name LIKE 'mtls%';
-- Should return: mtls_cert_serial_number, mtls_cert_expires_at, mtls_cert_issued_at, mtls_cert_cf_id

-- Check indexes
SELECT indexname FROM pg_indexes WHERE tablename = 'devices' AND indexname LIKE '%mtls%';
-- Should return: devices_mtls_cert_expires_idx
```

---

## Phase 4: Verify Agent Enrollment

### 4a. Enroll a Test Agent

```bash
breeze-agent enroll <enrollment-key> --server https://your-api.example.com
```

Expected output should include:
```
mTLS certificate issued (expires: 2026-05-12T00:00:00Z)
```

### 4b. Verify Agent Config

Check the agent config file (location varies by OS):

| OS | Path |
|----|------|
| Linux | `/etc/breeze/agent.yaml` |
| macOS | `/Library/Application Support/Breeze/agent.yaml` |
| Windows | `%ProgramData%\Breeze\agent.yaml` |

Confirm these fields are populated:
```yaml
mtls_cert_pem: "-----BEGIN CERTIFICATE-----\n..."
mtls_key_pem: "-----BEGIN PRIVATE KEY-----\n..."
mtls_cert_expires: "2026-05-12T00:00:00Z"
```

### 4c. Verify Database Record

```sql
SELECT agent_id, mtls_cert_serial_number, mtls_cert_expires_at, mtls_cert_cf_id
FROM devices
WHERE agent_id = '<agent-id>';
```

### 4d. Verify in Cloudflare Dashboard

1. Go to **SSL/TLS > Client Certificates** in the Cloudflare dashboard
2. You should see the newly issued certificate listed
3. Status should be "Active"

### 4e. Monitor Certificate Presentation

After starting the agent (`breeze-agent run`), check Cloudflare analytics or use:

```bash
# From the agent host, verify the cert is presented
openssl s_client -connect your-api.example.com:443 \
  -cert /path/to/cert.pem -key /path/to/key.pem \
  </dev/null 2>&1 | grep "SSL handshake"
```

---

## Phase 5: Enable WAF Enforcement

**Only proceed after confirming agents are presenting certificates in Phase 4.**

### 5a. Create WAF Custom Rules

In Cloudflare Dashboard > Security > WAF > Custom Rules, create rules to block requests without valid client certificates on agent routes:

**Rule 1: Enforce mTLS on agent API routes**
```
Expression:
(http.request.uri.path matches "^/api/v1/agents/[a-f0-9]+/" and not cf.tls_client_auth.cert_verified)

Action: Block
```

**Rule 2: Exclude enrollment and renewal endpoints**

Make sure these paths are NOT blocked (they need to work without mTLS):

- `/api/v1/agents/enroll` — new agents don't have certs yet
- `/api/v1/agents/renew-cert` — agents with expired certs need to renew

The WAF rule expression should explicitly exclude these:
```
(http.request.uri.path matches "^/api/v1/agents/[a-f0-9]+/"
 and not http.request.uri.path contains "/enroll"
 and not http.request.uri.path contains "/renew-cert"
 and not cf.tls_client_auth.cert_verified)
```

### 5b. Test Enforcement

```bash
# This should be BLOCKED (no client cert)
curl -X POST https://your-api.example.com/api/v1/agents/<agent-id>/heartbeat \
  -H "Authorization: Bearer brz_..." \
  -H "Content-Type: application/json" \
  -d '{}'

# This should SUCCEED (enrollment doesn't require cert)
curl -X POST https://your-api.example.com/api/v1/agents/enroll \
  -H "Content-Type: application/json" \
  -d '{"enrollmentKey": "test"}'
```

---

## Org-Level Settings

Each organization can configure mTLS behavior:

### Update Settings

```bash
curl -X PATCH https://your-api.example.com/api/v1/agents/org/<org-id>/settings/mtls \
  -H "Authorization: Bearer <user-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "certLifetimeDays": 90,
    "expiredCertPolicy": "auto_reissue"
  }'
```

### Available Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `certLifetimeDays` | integer | 90 | Certificate validity period (1-365 days) |
| `expiredCertPolicy` | string | `auto_reissue` | What happens when an agent's cert expires |

### Expired Certificate Policies

| Policy | Behavior |
|--------|----------|
| `auto_reissue` | Agent calls `/renew-cert` and gets a new certificate automatically |
| `quarantine` | Agent is quarantined and requires admin approval before getting a new cert |

---

## Admin Quarantine Management

When `expiredCertPolicy` is set to `quarantine`, devices with expired certificates are placed in quarantine status.

### List Quarantined Devices

```bash
curl https://your-api.example.com/api/v1/agents/quarantined \
  -H "Authorization: Bearer <user-jwt>"
```

Response:
```json
{
  "devices": [
    {
      "id": "uuid",
      "agentId": "hex-string",
      "hostname": "workstation-01",
      "osType": "windows",
      "quarantinedAt": "2026-02-11T10:00:00.000Z",
      "quarantinedReason": "mtls_cert_expired"
    }
  ]
}
```

### Approve a Quarantined Device

Issues a new certificate and sets the device back to `online`:

```bash
curl -X POST https://your-api.example.com/api/v1/agents/<device-id>/approve \
  -H "Authorization: Bearer <user-jwt>"
```

### Deny a Quarantined Device

Moves the device to `decommissioned` status:

```bash
curl -X POST https://your-api.example.com/api/v1/agents/<device-id>/deny \
  -H "Authorization: Bearer <user-jwt>"
```

---

## Certificate Lifecycle

```
Enrollment
    │
    ▼
┌─────────────────────┐
│  Certificate Issued  │  (valid for certLifetimeDays)
│  Status: online      │
└─────────────────────┘
    │
    │  At 2/3 of lifetime...
    ▼
┌─────────────────────┐
│  Heartbeat returns   │  renewCert: true
│  renewCert: true     │
└─────────────────────┘
    │
    │  Agent calls POST /renew-cert
    ▼
┌─────────────────────┐
│  New cert issued     │  Old cert revoked
│  Status: online      │
└─────────────────────┘

If cert expires before renewal...
    │
    ▼
┌─────────────────────────────────────────┐
│  Agent startup detects expired cert     │
│  Calls POST /renew-cert                 │
└─────────────────────────────────────────┘
    │                           │
    │ auto_reissue policy       │ quarantine policy
    ▼                           ▼
┌──────────────┐    ┌────────────────────────┐
│ New cert      │    │ Status: quarantined     │
│ issued        │    │ Awaiting admin approval │
│ Status: online│    └────────────────────────┘
└──────────────┘         │              │
                         │ approve      │ deny
                         ▼              ▼
                    ┌──────────┐  ┌─────────────────┐
                    │ New cert  │  │ decommissioned   │
                    │ online    │  └─────────────────┘
                    └──────────┘
```

### Proactive Renewal (normal flow)

1. Heartbeat checks: `now >= issuedAt + (expiresAt - issuedAt) * 2/3`
2. If true, heartbeat response includes `renewCert: true`
3. Agent spawns a background goroutine to call `POST /renew-cert`
4. Old cert is revoked, new cert is issued
5. Agent saves new cert to config file
6. New cert is used on next WebSocket reconnect (active connections are not interrupted)

### Fallback Renewal (agent was offline)

1. Agent starts up and loads cert from config
2. Detects cert is expired via `mtls.IsExpired()`
3. Creates a bearer-only HTTP client (no mTLS for this call)
4. Calls `POST /renew-cert`
5. If `auto_reissue`: gets new cert, saves to config, continues startup
6. If `quarantine`: logs warning, continues without mTLS

---

## Troubleshooting

### Agent enrolled but no mTLS cert

**Cause:** `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ZONE_ID` not set on the API server.

**Fix:** Set both env vars and restart the API. Re-enroll the agent or wait for the next heartbeat cycle.

### Cloudflare API returns 403

**Cause:** API token doesn't have the correct permissions.

**Fix:** Ensure the token has `Zone > SSL and Certificates > Edit` permission scoped to the correct zone.

### Agent can't connect after WAF enforcement

**Cause:** Agent doesn't have a certificate or certificate has expired.

**Fix:**
1. Check if the agent config file has `mtls_cert_pem` populated
2. If empty, re-enroll the agent
3. If expired, the agent should auto-renew on startup — check API logs for `/renew-cert` calls

### Device stuck in quarantined status

**Cause:** Org policy is `quarantine` and the agent's cert expired.

**Fix:** An admin must approve the device:
```bash
curl -X POST https://api.example.com/api/v1/agents/<device-id>/approve \
  -H "Authorization: Bearer <admin-jwt>"
```

### Certificate renewal fails

**Cause:** Cloudflare API rate limiting or service outage.

**Fix:** The agent will retry on next heartbeat (every 60s by default). Check API logs for `[agents] mTLS cert renewal failed` messages.

### Pre-existing agents (enrolled before mTLS)

Pre-existing agents have no mTLS cert columns populated. They continue working with bearer-token-only auth. To add mTLS:

1. **Option A:** Re-enroll the agent (generates new credentials + cert)
2. **Option B:** Wait — the agent will not receive `renewCert: true` since it has no cert to renew. Manual re-enrollment is required for existing agents to get mTLS.

---

## API Reference

### Agent Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/agents/enroll` | Enrollment key | Enroll device, optionally issue mTLS cert |
| `POST` | `/api/v1/agents/:id/heartbeat` | Agent bearer + mTLS | Heartbeat, may signal `renewCert` |
| `POST` | `/api/v1/agents/renew-cert` | Agent bearer only | Request new mTLS cert (WAF-excluded) |

### Admin Endpoints (User JWT Auth)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/agents/quarantined` | List quarantined devices |
| `POST` | `/api/v1/agents/:id/approve` | Approve quarantined device |
| `POST` | `/api/v1/agents/:id/deny` | Deny (decommission) quarantined device |
| `PATCH` | `/api/v1/agents/org/:orgId/settings/mtls` | Update org mTLS settings |

### Enrollment Response (with mTLS)

```json
{
  "agentId": "abc123...",
  "deviceId": "uuid",
  "authToken": "brz_...",
  "orgId": "uuid",
  "siteId": "uuid",
  "config": {
    "heartbeatIntervalSeconds": 60,
    "metricsCollectionIntervalSeconds": 30
  },
  "mtls": {
    "certificate": "-----BEGIN CERTIFICATE-----\n...",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...",
    "expiresAt": "2026-05-12T00:00:00Z",
    "serialNumber": "abc123..."
  }
}
```

### Heartbeat Response (with renewal signal)

```json
{
  "commands": [],
  "configUpdate": null,
  "upgradeTo": null,
  "renewCert": true
}
```

### Renew Cert Response (success)

```json
{
  "mtls": {
    "certificate": "-----BEGIN CERTIFICATE-----\n...",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...",
    "expiresAt": "2026-05-12T00:00:00Z",
    "serialNumber": "def456..."
  }
}
```

### Renew Cert Response (quarantined)

```json
{
  "error": "Device quarantined",
  "quarantined": true
}
```
