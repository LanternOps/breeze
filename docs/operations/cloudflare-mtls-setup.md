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
7. [Phase 6: Edge Assertion Contract and API-Layer Binding](#phase-6-edge-assertion-contract-and-api-layer-binding)
8. [Org-Level Settings](#org-level-settings)
9. [Admin Quarantine Management](#admin-quarantine-management)
10. [Certificate Lifecycle](#certificate-lifecycle)
11. [Troubleshooting](#troubleshooting)
12. [API Reference](#api-reference)

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

In Cloudflare Dashboard > Security > WAF > Custom Rules, create **one** rule that blocks requests
without a verified client certificate on the exact protected set below. This is the canonical
expression — it is mirrored verbatim in `docker/Caddyfile.prod` (the `@agentMtlsProtected` matcher)
and CI-enforced by `scripts/check-agent-mtls-edge-policy.sh` (`pnpm check:agent-mtls-edge-policy`),
so all three copies stay identical by construction.

**Rule: Enforce mTLS on the protected agent route set**

```
Expression:
(
  http.request.uri.path matches "^/api/v1/agents/[0-9a-fA-F]{64}(?:/.*)?$"
  or http.request.uri.path eq "/api/v1/agents/renew-cert/confirm"
  or http.request.uri.path matches "^/api/v1/agent-ws/[0-9a-fA-F]{64}/ws$"
  or http.request.uri.path matches "^/api/v1/(?:ext/)?[a-z0-9][a-z0-9-]*/agent/[0-9a-fA-F]{64}(?:/.*)?$"
)
and http.request.uri.path not in {
  "/api/v1/agents/enroll"
  "/api/v1/agents/renew-cert"
  "/api/v1/agents/renew-cert/challenge"
}
and not cf.tls_client_auth.cert_verified

Action: Block
```

Protected set, exactly:

| Set | Expression | Why |
|---|---|---|
| REST identity | `^/api/v1/agents/[0-9a-fA-F]{64}(?:/.*)?$` | Every per-device agent REST route (heartbeat, metrics, commands, etc.) |
| Renewal confirmation | `/api/v1/agents/renew-cert/confirm` (exact) | Proves possession of the **newly issued** identity — protected even though renewal itself is bearer-only |
| Command WebSocket | `^/api/v1/agent-ws/[0-9a-fA-F]{64}/ws$` | The command channel carries the same device identity as REST and must get the same coverage |
| Extension agent mount | `^/api/v1/(?:ext/)?[a-z0-9][a-z0-9-]*/agent/[0-9a-fA-F]{64}(?:/.*)?$` | Extensions that declare `agentRoutes: true` mount a second agent-token surface at `/api/v1/ext/<extension>/agent/<agentId>` and `/api/v1/<routeNamespace>/agent/<agentId>`, authenticated by the same device identity |

### Why the identity segment is 64 hex characters, not a UUID

The path parameter on every agent route is the **agent ID**, not the device UUID. It is generated as
`randomBytes(32).toString('hex')` (`apps/api/src/routes/agents/helpers.ts`, `generateAgentId`) — a
**64-character hex string** — and is matched against `devices.agent_id` by
`apps/api/src/middleware/agentAuth.ts` and `apps/api/src/routes/agentWs.ts`.

An earlier form of this rule used `[0-9a-fA-F-]{36}`, a UUID shape. That was **exactly inverted**: it
matched no agent route at all, while it *did* match the 36-character UUID **admin** routes
(`/api/v1/agents/<deviceId>/approve`, `/reject`, `/quarantined`, …). Those are user-JWT +
permission-gated browser routes whose operators have no client certificate, so the rule would have
blocked administrators while leaving every agent route unprotected. `{64}` cannot match a 36-character
UUID, so the admin surface is excluded structurally — not by an exemption entry that could be dropped.

Exact exemptions (bearer-only; a device has no active certificate identity to bind yet):

- `/api/v1/agents/enroll` — new agents don't have certs yet
- `/api/v1/agents/renew-cert` — legacy/protocol-v2 renewal request itself
- `/api/v1/agents/renew-cert/challenge` — proof-of-possession challenge issuance

**Do not use `contains`, a trailing-wildcard renewal path, or any other broad substring match for the
exemption.** The identity regex above already requires a full 64-character hex segment, so none of
the three exempt paths can ever match it by accident — the exemption clause exists for defense in
depth and auditability, not because the regex is ambiguous. A broad substring match on the renewal
path (the previous form of this rule) also accidentally exempted the confirmation route, which
defeats the entire point of confirmation being protected.

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

### 5c. Test Spoofing Resistance

The WAF rule stops an unverified request at the edge, but that alone doesn't prove the API can't be
fooled by a forged assertion header if a request ever reaches it some other way (e.g. from inside
your own network, or from a host that can reach the API's port directly). Prove the API's own
trust-gating holds independently of Cloudflare's block, by sending a request that presents **no
real client certificate at all** but forges both assertion headers directly — from a host that is
*not* your configured trusted proxy (i.e. not through Caddy, or from outside `TRUSTED_PROXY_CIDRS`):

```bash
# From a host that is NOT the configured trusted proxy (bypassing Caddy/Cloudflare
# entirely — e.g. reaching the api container's port directly inside your network):
curl -X POST http://api-host:3001/api/v1/agents/<agent-id>/heartbeat \
  -H "Authorization: Bearer brz_..." \
  -H "X-Breeze-Client-Cert-Verified: true" \
  -H "X-Breeze-Client-Cert-Serial: DEADBEEF00000000000000000000000000000000" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected: the API must treat this exactly as if no assertion had been presented at all — the forged
headers must have **zero effect** on the outcome. Concretely:

- In `audit` mode, the certificate-binding metric
  (`breeze_agent_certificate_binding_total{mode="audit",reason,path_class}`) must record
  `missing_assertion` or `untrusted_assertion` for this request, never `matched` — proving
  `assertionTrusted` came back `false` because the request's immediate peer wasn't a configured
  trusted proxy, regardless of what the forged headers claimed.
- In `enforce` mode with the device's certificate history `active`, this exact request must be
  **denied** (`401`), not merely counted.

If this probe ever succeeds as if it were a genuine verified assertion, something is trusting
headers from an unconfigured source — check `TRUSTED_PROXY_CIDRS` and `trustsForwardedHeadersFrom`
before assuming the edge normalization itself is at fault; the API never reads a raw provider header
directly, so a bypass here means the trust boundary, not the header names, is misconfigured.

---

## Phase 6: Edge Assertion Contract and API-Layer Binding

Cloudflare's WAF rule in Phase 5 stops unverified traffic at the edge, but it cannot tell the API
*which* device presented the certificate — that per-device match is the API's job
(`AGENT_MTLS_BINDING_MODE`, `apps/api/src/services/agentCertificateBinding.ts`). The edge's job is to
hand the API a verified result the API can trust, and to guarantee a client can never forge that
result directly.

### The assertion contract

The API reads exactly two internal headers and nothing else:

| Header | Meaning |
|---|---|
| `X-Breeze-Client-Cert-Verified` | `true` only when the request's mTLS handshake was verified by the trusted edge |
| `X-Breeze-Client-Cert-Serial` | The verified certificate's serial number, uppercase hex, no separators |

These are trusted **only** when the request's immediate peer is a configured trusted proxy
(`TRUSTED_PROXY_CIDRS` / `trustsForwardedHeadersFrom`) — the same authority already used for
`X-Forwarded-For` and `X-Forwarded-Proto`. The API never reads raw Cloudflare headers
(`Cf-Client-Cert-*`) or any other provider-specific certificate metadata directly; it only ever reads
these two.

### What the last trusted hop (Caddy) must do

`docker/Caddyfile.prod` implements this normalization on every request proxied to the API, at the
last hop before the origin (Internet → cloudflared → Caddy → API):

1. **Discard** any inbound `X-Breeze-Client-Cert-Verified` / `X-Breeze-Client-Cert-Serial` a client
   sent directly — a request must never be able to forge these itself. This is done **once,
   globally**, as the first directive in the site block (`request_header -X-Breeze-...`), *not* per
   route. Several routes reach the same `api:3001` origin through their own `handle` blocks —
   `/api/v1/mcp/sse`, `/api/v1/ai/sessions/*/stream`,
   `/api/v1/helper/chat/sessions/*/messages`, `/oauth/*`, and the OAuth `.well-known` endpoints —
   and a per-route strip has to be remembered for every one of them, including routes added later.
   A global strip makes the safe state the default.
2. **Discard** raw provider certificate headers arriving from any upstream that isn't the trusted
   proxy hop (Cloudflare's `Cf-Client-Cert-*` family) — they are edge-internal, not part of the
   contract the API understands. This *is* per route, on every `reverse_proxy` that reaches the API
   origin, because the `/api/*` block still needs to read `Cf-Client-Cert-Verified` to derive the
   assertion (step 3) before discarding it.
3. **Set** the two Breeze headers **only** from a verified Cloudflare mTLS result — in the bundled
   config, a Cloudflare Transform Rule ("Modify Request Header") that templates
   `cf.tls_client_auth.cert_verified` and `cf.tls_client_auth.cert_serial` into
   `Cf-Client-Cert-Verified` / `Cf-Client-Cert-Serial`, which Caddy then maps through a strict
   allowlist (only the literal `true` passes; everything else — absent, malformed, or a value an
   operator didn't intend — becomes `false`) before renaming to the Breeze pair. An operator running
   their own local mTLS-terminating proxy instead of Cloudflare must reproduce the same allowlist
   shape from their verifier's own verified-peer-certificate result.
4. **Never** forward the client certificate PEM, DER, or any private key material to the API — only
   the normalized verified/serial pair crosses this hop. Cloudflare's own certificate-forwarding
   headers (`Cf-Client-Cert-Der-Base64`, `Cf-Client-Cert-Sha256`) are explicitly stripped even if a
   future change to your zone's *Client Certificate Forwarding* setting starts sending them.

> **Never put step 1's discard and step 3's set in the same `reverse_proxy` block.** Caddy compiles
> all of a `reverse_proxy`'s `header_up` lines into one header-operation set and applies **deletes
> after sets**, regardless of the order they appear in the Caddyfile. A
> `header_up -X-Breeze-Client-Cert-Verified` written above a
> `header_up X-Breeze-Client-Cert-Verified {breeze_agent_cert_verified}` therefore erases the value
> that was just derived, and the origin receives *no* assertion at all — the binding layer goes
> silently inert, `enforce` denies every request, and nothing logs an error. The global
> `request_header` strip in step 1 avoids this by construction, and
> `scripts/check-agent-mtls-edge-policy.sh` fails the build if the two are ever co-located again.
> Note also that a `header_up X-Foo {placeholder}` **replaces** an inbound `X-Foo` rather than
> appending to it, even when the placeholder resolves to the empty string, so the set in step 3 is
> independently sufficient to keep a forged inbound value from surviving.

### Direct-origin bypass warning

**This entire contract depends on the API never being reachable except through the trusted edge.**
If your origin (the `api` container, or Caddy in front of it) is reachable directly — a public IP, a
misconfigured firewall rule, a load balancer that bypasses the Cloudflare Tunnel — an attacker who
reaches Caddy or the API directly can set `X-Breeze-Client-Cert-Verified: true` themselves, and
Caddy's normalization (step 1 above) only strips a request's *first* hop; it cannot undo a forged
`Cf-Client-Cert-Verified` header sent straight to Caddy by an attacker who bypassed Cloudflare
entirely. Keep the origin firewalled to the Cloudflare Tunnel / cloudflared hop only (see the
existing `CADDY_TRUSTED_PROXIES` / pinned-hop guidance in `docker/Caddyfile.prod`); do not expose the
API or Caddy's port on a public interface as a "just in case" fallback.

### Mode progression: `off` → `audit` → `enforce`

`AGENT_MTLS_BINDING_MODE` (API env var) defaults to `off` everywhere, including self-hosted and mixed
hosted deployments. It only ever changes behavior when an operator explicitly sets it:

| Mode | Behavior |
|---|---|
| `off` (default) | The assertion is never consulted. Zero behavior change — safe with no Cloudflare mTLS configured at all. |
| `audit` | The binding decision is computed and counted (`breeze_agent_certificate_binding_total{mode="audit",reason,path_class}`) but **never denies**. Use this to measure mismatch/missing rates before enforcing. |
| `enforce` | A device with an active stored certificate must present a verified, matching assertion on every protected REST and command-WebSocket request, or the request is denied. A device with no certificate history at all (legacy, pre-mTLS) remains allowed — this is the only unconditional pass in `enforce`, so mixed-version fleets do not break. |

Roll out `off → audit → enforce` in that order, watching the metric for a representative window before
advancing. Rolling back is always `AGENT_MTLS_BINDING_MODE=off` — certificate history and durable
revocation state are untouched.

### Self-hosted guidance

**Leave `AGENT_MTLS_BINDING_MODE=off` unless your reverse proxy actually validates the peer
certificate and strips/overwrites both `X-Breeze-Client-Cert-Verified` and
`X-Breeze-Client-Cert-Serial` at the last hop before the API**, exactly as Caddy does above. Setting
these headers from arbitrary client input — or running a proxy that merely forwards whatever a
client sent — is **explicitly unsupported** and equivalent to disabling authentication for every
protected route once the mode is anything other than `off`. If you don't operate your own
mTLS-terminating proxy, do not enable `audit` or `enforce`.

### Setting the mode (self-hosted and hosted alike)

`AGENT_MTLS_BINDING_MODE` is mapped explicitly into the `api` service `environment:` block in both
`docker-compose.yml` and `deploy/docker-compose.prod.yml`, defaulted to `off`:

```yaml
AGENT_MTLS_BINDING_MODE: ${AGENT_MTLS_BINDING_MODE:-off}
```

Set it in your `.env` file — `docker-compose.yml` does not read it any other way, and an unset
`.env` value resolves to `off` with no behavior change. There is no build-time or `NODE_ENV`-based
inference: `IS_HOSTED`, `NODE_ENV`, and the `CF_MTLS_*` issuance variables never influence this
value, on either the self-hosted or hosted stack. The operator always selects the mode by hand,
per the rollout sequence above.

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
