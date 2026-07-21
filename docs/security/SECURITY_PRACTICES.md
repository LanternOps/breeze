# Security Practices

Breeze is an RMM platform — it has privileged access to every device it manages. We treat that responsibility as seriously as you do. Security is not a feature we bolted on; it is foundational to every layer of the architecture.

This document describes the security controls, practices, and design decisions in Breeze. It is intended for MSPs evaluating Breeze, security teams conducting assessments, and contributors building on the platform.

---

## Table of Contents

- [Security Architecture Overview](#security-architecture-overview)
- [Authentication](#authentication)
- [Authorization & Multi-Tenancy](#authorization--multi-tenancy)
- [Agent Security](#agent-security)
- [Peripheral Control](#peripheral-control)
- [Encryption](#encryption)
- [Rate Limiting & Abuse Prevention](#rate-limiting--abuse-prevention)
- [Input Validation](#input-validation)
- [HTTP Security Headers](#http-security-headers)
- [Audit Logging](#audit-logging)
- [Incident Response Automation](#incident-response-automation)
- [AI Risk Classification](#ai-risk-classification)
- [Infrastructure Security](#infrastructure-security)
- [Supply Chain Security](#supply-chain-security)
- [Secret Management](#secret-management)
- [Operational Security](#operational-security)
- [Vulnerability Disclosure](#vulnerability-disclosure)
- [SOC 2 Alignment](#soc-2-alignment)

---

## Security Architecture Overview

```
                         ┌──────────────────────────────────────────┐
                         │            Security Layers               │
                         ├──────────────────────────────────────────┤
                         │  TLS/HSTS ─── Transport Encryption       │
                         │  CORS ─────── Origin Allowlist           │
                         │  CSP ──────── Content Security Policy    │
                         │  CSRF ─────── State-Change Protection    │
                         │  Rate Limit ─ Redis Sliding Window       │
                         │  Auth ─────── JWT + MFA + Sessions       │
                         │  RBAC ─────── Permission Enforcement     │
                         │  Tenant ───── PostgreSQL Row Isolation   │
                         │  Audit ────── Structured Event Logging   │
                         │  Encryption ─ AES-256-GCM At Rest        │
                         └──────────────────────────────────────────┘
```

Every request passes through multiple security layers before reaching application logic. No single layer is relied upon in isolation.

---

## Authentication

### User Authentication

Breeze implements a multi-factor authentication system with defense-in-depth:

| Control | Implementation |
|---|---|
| **Password hashing** | Argon2id — 64 MB memory, 3 iterations, 4 threads |
| **Password policy** | 8-128 chars, mixed case, numeric required |
| **Access tokens** | JWT (HS256), 15-minute lifetime, audience/issuer-scoped |
| **Refresh tokens** | JWT, 7-day lifetime, unique JTI, revocable |
| **Session tokens** | cryptographically random (nanoid 48), SHA-256 hashed in DB |
| **MFA** | TOTP (RFC 6238), 10 recovery codes (XXXX-XXXX format) |
| **SMS MFA** | Optional Twilio integration for SMS-based codes |
| **Token revocation** | Explicit session invalidation, bulk logout per user |

Plaintext tokens are never stored. All token storage uses SHA-256 hashes.

### API Key Authentication

API keys follow the same security model as agent tokens:

- **Format**: `brz_` prefix for identification
- **Storage**: SHA-256 hash only — the plaintext key is shown once at creation, never again
- **Scoping**: JSONB scope array with wildcard support (`*` for full access)
- **Lifecycle**: Configurable expiration, revocable, status tracking (active/revoked/expired)
- **Rate limiting**: Per-key configurable request limits
- **Audit trail**: `lastUsedAt` timestamp and `usageCount` updated on every use

### Agent Authentication

See [Agent Security](#agent-security) below.

---

## Authorization & Multi-Tenancy

### Multi-Tenant Hierarchy

```
Partner (MSP) → Organization (Customer) → Site (Location) → Device Group → Device
```

Every entity is scoped to this hierarchy. A user at one organization can never access another organization's data — this is enforced at the database layer, not just the application layer.

### Database-Level Tenant Isolation

Breeze sets PostgreSQL session variables on every request:

```
breeze.scope           = 'system' | 'partner' | 'organization'
breeze.org_id          = UUID of current organization
breeze.accessible_org_ids = comma-separated list or '*'
```

These variables are set via `set_config()` within the request transaction context using Node.js `AsyncLocalStorage`. Queries that don't have proper context set will fail — there is no default permissive state.

As of v0.65.0, every tenant-scoped table is configured with `FORCE ROW LEVEL SECURITY` in addition to having policies enabled. PostgreSQL evaluates RLS policies for *all* roles — including the table owner — eliminating the residual risk that an operator-mode connection (migrations, maintenance, or a custom deployment running the API as a privileged role) could accidentally bypass tenant isolation. The application connects as the unprivileged `breeze_app` role for all request-path queries, and FORCE RLS now enforces the same policy evaluation even when administrative roles touch the data. The migration that applies FORCE RLS to all currently-discovered tenant tables is `apps/api/migrations/2026-05-03-tenant-rls-force-and-invites.sql`; the contract test `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` keeps coverage from regressing as new tables are added.

### Platform Admin

Platform admin is a separate authorization axis from the partner/organization RBAC system. The `users.is_platform_admin` boolean flag gates the cross-tenant `/admin/*` endpoints (audit forensic queries, abuse response, partner suspension) which need to operate above any single tenant's scope.

| Property | Implementation |
|---|---|
| **Schema** | `users.is_platform_admin` boolean column (defaults to `false`) |
| **Bootstrap** | `BREEZE_PLATFORM_ADMINS` env var — comma-separated email allowlist, applied on API startup |
| **Middleware** | `platformAdminMiddleware` (`apps/api/src/middleware/platformAdmin.ts`) — runs `authMiddleware` then enforces `isPlatformAdmin === true`, fails closed with 403 |
| **Audit** | Every authorized request is recorded as `platform_admin.<route>` in `audit_logs`, including method, path, actor, and trusted client IP |

Platform admin is intentionally orthogonal to roles: a platform admin must still hold the appropriate organization or partner role to act on tenant-scoped data via normal endpoints. The flag only unlocks the cross-tenant administrative surface.

### Role-Based Access Control

| Component | Description |
|---|---|
| **Roles** | Named definitions scoped to system, partner, or organization level |
| **Permissions** | Atomic `resource:action` pairs (e.g., `devices:read`, `scripts:execute`) |
| **Wildcards** | `*:*` grants all permissions (system admin only) |
| **Middleware** | `requirePermission(resource, action)` enforced on every protected route |
| **Caching** | 5-minute in-memory permission cache to reduce DB lookups |

### Scope Enforcement

Three scope levels control data visibility:

- **System**: Full access to all organizations (super-admin only)
- **Partner**: MSP access to their portfolio, configurable per-org (`all`, `selected`, `none`)
- **Organization**: Single-tenant access, no cross-org visibility

Scope is computed once per request via `resolveOrgAccess()` and applied to all downstream queries.

---

## Agent Security

The agent runs on customer endpoints with elevated privileges. Its security is paramount.

### Token Security

- **Format**: `brz_` prefix tokens generated during enrollment
- **Hashing**: SHA-256 hash stored in `devices.agentTokenHash` — plaintext never persisted server-side
- **Validation**: Every agent REST request and WebSocket connection validates the bearer token against the stored hash
- **Status checks**: Decommissioned and quarantined devices are rejected with 403

When a device record exists in the database but has no token hash — the case for legacy devices enrolled before the v0.62 token-hash migration — the API returns a structured `{ code: "re_enrollment_required" }` signal on both the WebSocket auth path and HTTP 401 responses (`apps/api/src/middleware/agentAuth.ts`, `apps/api/src/routes/agentWs.ts`). The agent treats this as a non-fault terminal state: it stops retrying with the orphaned credential and prompts the operator to re-enroll the device, rather than silently failing in a reconnect loop or appearing healthy while unable to receive commands. This makes upgrade behavior explicit and auditable.

### Config File Permissions

The agent stores sensitive configuration (auth token, org/site IDs) on disk with restricted permissions:

| Resource | Permission | Rationale |
|---|---|---|
| Config directory | `0700` (rwx------) | No access for other users or groups |
| Config file | `0600` (rw-------) | Read/write only by the agent process |

### Mutual TLS (mTLS) — Optional

For organizations requiring proof-of-possession at the TLS layer:

- **Certificate authority**: Cloudflare Client Certificates API
- **Enrollment**: mTLS cert issued during agent enrollment, PEM + private key delivered to agent
- **Renewal**: Automatic at 2/3 certificate lifetime via heartbeat signal
- **Quarantine policy**: Devices with expired/revoked certs are quarantined pending admin review
- **WAF integration**: Cloudflare API Shield enforces client certificate validation at the edge
- **No behavior change by default**: mTLS is entirely optional and requires explicit Cloudflare credentials

Full setup guide: [cloudflare-mtls-setup.md](cloudflare-mtls-setup.md)

### WebSocket Security

Agent WebSocket connections are validated on connect:

1. Bearer token extracted from `Authorization` header (or `?token=` query param as fallback)
2. Token hashed with SHA-256 and compared against device record
3. Device status verified (online, not decommissioned/quarantined)
4. All incoming messages validated against Zod discriminated union schema
5. Device status updated on connect/disconnect

### Command Execution Auditing

Mutating commands sent to agents are logged to the audit trail:

- Registry modifications (`REGISTRY_DELETE`, `REGISTRY_KEY_DELETE`)
- File operations (`FILE_DELETE`)
- Patch operations (`PATCH_SCAN`, `INSTALL_PATCHES`, `ROLLBACK_PATCHES`)
- Audit baseline remediation (`APPLY_AUDIT_POLICY_BASELINE`)

Each audit entry captures: command type, target device, exit code, stderr output, and the actor who initiated the command.

Audit baseline remediation additionally uses explicit approval requests with separation of duties: the requester cannot self-approve, and approvals are single-use with expiration.

---

## Peripheral Control

Breeze includes policy-driven USB/peripheral controls for data-exfiltration resistance and forensic visibility.

### Policy Model

- **Classes**: `storage`, `all_usb`, `bluetooth`, `thunderbolt`
- **Actions**: `allow`, `block`, `read_only`, `alert`
- **Scope targets**: organization, site, group, or device
- **Exceptions**: explicit vendor/product/serial overrides for approved media

### High-Risk Change Protections

- Policy mutations require org write permission and MFA when performed through API routes. AI-initiated mutations are gated by tier-3 approval (human confirmation) instead of MFA.
- Every policy mutation emits an auditable event (`peripheral.policy_changed`).
- Emergency rollback is first-class via policy disable endpoint.

### Telemetry & Auditability

- Agents submit peripheral telemetry as structured events (`connected`, `blocked`, etc.).
- Blocked activity emits correlation events (`peripheral.blocked`).
- Periodic anomaly detection emits `peripheral.unauthorized_device` when blocked activity crosses threshold. Default: 5+ blocked events per device within a 30-minute lookback window, scanned every 15 minutes. Configurable via `PERIPHERAL_ANOMALY_BLOCKED_THRESHOLD`.
- All ingestion and policy operations are written to audit logs for immutable review.

---

## Encryption

### In Transit

| Control | Implementation |
|---|---|
| **TLS termination** | Caddy reverse proxy with automatic Let's Encrypt certificates |
| **HSTS** | `max-age=31536000; includeSubDomains; preload` |
| **HTTP redirect** | Optional `FORCE_HTTPS` environment variable |
| **WebSocket** | WSS (encrypted WebSocket) for all agent communication |
| **Internal traffic** | API listens on localhost only — no unencrypted external exposure |

### At Rest

| Data | Algorithm | Details |
|---|---|---|
| **Passwords** | Argon2id | 64 MB memory, 3 iterations, 4 threads, 32-byte hash |
| **Auth tokens** | SHA-256 | One-way hash — tokens, API keys, session tokens, enrollment keys |
| **Secrets** | AES-256-GCM | Authenticated encryption with per-operation random IV |
| **MFA secrets** | AES-256-GCM | Encrypted before storage, decrypted only during verification |

### Secret Encryption Details

Breeze uses versioned, prefixed ciphertext formats so that the storage format is self-describing and rotation is a per-row operation, never a global re-encrypt-or-fail event.

#### Application secrets — `enc:v1:` / `enc:v2:`

| Format | Purpose |
|---|---|
| `enc:v1:{base64url(iv)}.{base64url(authTag)}.{base64url(ciphertext)}` | Single-key AES-256-GCM under `APP_ENCRYPTION_KEY` |
| `enc:v2:{keyId}:{base64url(iv)}.{base64url(authTag)}.{base64url(ciphertext)}` | Keyring-aware AES-256-GCM, key resolved from `APP_ENCRYPTION_KEYRING` JSON or the active `APP_ENCRYPTION_KEY_ID` |

- AES-256-GCM with a fresh 12-byte random IV per operation (never reused)
- GCM authentication tag rejects any tampered ciphertext on decrypt
- `isEncryptedSecret()` guard prevents double-encryption when the same value is rewritten
- Active key may carry an `APP_ENCRYPTION_KEY_ID` so future writes are tagged with `enc:v2:`; the keyring lets multiple key versions coexist while migration runs

**Dual-decrypt fallback chain (v0.65.0).** Earlier versions of Breeze derived the secret-encryption key from `JWT_SECRET` (and at one point `SESSION_SECRET`). v0.65.0 made `APP_ENCRYPTION_KEY` mandatory in production but adds a read-only fallback chain so existing rows decrypt transparently after upgrade: a primary-key decrypt failure on an `enc:v1:` row triggers a retry against any `JWT_SECRET` / `SESSION_SECRET` values present in the environment. Successful fallback decryption emits a one-time `[secretCrypto] Decrypted enc:v1: row with legacy fallback key` warning so operators can run `scripts/re-encrypt-secrets.ts` to re-encrypt the row under the dedicated key. New writes always use the active `APP_ENCRYPTION_KEY` — the legacy keys are never used for encryption.

#### MFA secrets — `mfa:v1:`

TOTP shared secrets are encrypted under a dedicated key, isolated from the general application-secrets key:

- Format: `mfa:v1:{base64url(iv)}.{base64url(authTag)}.{base64url(ciphertext)}`
- Algorithm: AES-256-GCM with `MFA_ENCRYPTION_KEY` (SHA-256 derived)
- Backwards-compatible read: rows still in the legacy `enc:v1:` format are decrypted via `decryptSecret()` and surfaced for in-place migration to `mfa:v1:` (`decryptMfaTotpSecretForMigration` returns both plaintext and a re-encrypted blob), so existing TOTP setups survive the upgrade without forcing every user to re-enroll MFA

Isolating the MFA key means an exposure of `APP_ENCRYPTION_KEY` does not also expose every TOTP shared secret, and rotating one key does not require touching the other.

#### Pepper system — enrollment keys & MFA recovery codes

Enrollment keys and MFA recovery codes are SHA-256 hashed with a server-side pepper before storage, so a database snapshot alone cannot be brute-forced:

- **Enrollment keys**: peppered with `ENROLLMENT_KEY_PEPPER` (`apps/api/src/services/enrollmentKeySecurity.ts`)
- **MFA recovery codes**: peppered with `MFA_RECOVERY_CODE_PEPPER`

Each pepper has a **primary + legacy fallback list**: new writes use the primary value, but lookups also try every legacy pepper in the candidate list (e.g. older deployments that derived the pepper from `APP_ENCRYPTION_KEY` / `JWT_SECRET` before dedicated peppers were required). This lets operators promote a fresh dedicated pepper to primary without invalidating any existing enrollment keys or recovery codes already in the database.

#### Rotation

Encryption-at-rest rotation procedures (key generation, keyring rollout, re-encryption batch jobs, and verification) are documented in [SECRET_ROTATION.md](SECRET_ROTATION.md).

---

## Rate Limiting & Abuse Prevention

Breeze uses Redis-backed sliding window rate limiting. The implementation is **fail-closed** — if Redis is unavailable, requests are denied.

### Configured Limits

| Endpoint | Limit | Window | Key |
|---|---|---|---|
| Login attempts | 5 | 5 minutes | Per email |
| Password reset | 3 | 1 hour | Per email |
| MFA verification | 5 | 5 minutes | Per user |
| SMS verification | 3 | 1 hour | Per phone |
| SMS login | 3 | 5 minutes | Per email |
| Agent requests | 120 | 60 seconds | Per device |
| API key requests | Configurable | 1 hour | Per key |

### Implementation

- **Algorithm**: Redis sorted set (ZSET) sliding window
- **Atomicity**: `MULTI` pipeline for race-condition-free counting
- **Auto-cleanup**: Keys expire after the window elapses
- **Response**: Standard `X-RateLimit-*` headers and `429` with `Retry-After`

### Abuse Controls

Beyond per-endpoint rate limiting, v0.65.0 introduces platform-admin-only abuse controls and a hardened email-verification flow. The supporting schema lives in `apps/api/migrations/2026-05-04-anti-abuse-foundation.sql`.

#### Partner suspension for abuse

`POST /admin/partners/:id/suspend-for-abuse` — gated by `platformAdminMiddleware`, requires a written reason (≥10 chars) — performs a single transactional sweep that:

1. Sets the partner's status to `suspended`
2. Queues a `self_uninstall` command for every device under the partner (multi-row INSERT)
3. Cancels any other pending or in-flight commands for those devices
4. Deletes all sessions for users in the partner (excluding the calling platform admin if they happen to be a member, so the responder stays signed in)
5. Disables every non-platform-admin user belonging to the partner
6. Revokes every API key belonging to organizations under the partner
7. Outside the transaction, blanket-revokes JWTs for every affected user via Redis (`revokeAllUserTokens`)

Step 7 is **fail-closed**: if any Redis revocation rejects, the endpoint returns HTTP 500 with `tokenRevocationFailed: true` and a list of the failures, and the audit log is written with `result: 'failure'`. The DB-level suspend has already committed at that point, so the partner is suspended and devices are queued for uninstall — but the operator is loudly told that some existing JWTs may continue to authenticate until natural expiry, so they can flush Redis manually and re-run the call. An unsuspend endpoint (`POST /admin/partners/:id/unsuspend`) is provided for reversible cases; it preserves the activation gate (only flips to `active` if a payment method was attached, otherwise returns the partner to `pending`) and re-enables disabled users. Uninstalled devices are not auto-restored — re-enrollment is required.

#### Email verification on signup

New partner signups must verify their email address before the account is fully activated. Verification tokens have explicit terminal states beyond a binary used/unused flag:

| State | Meaning | Returned to user |
|---|---|---|
| `consumed` | Token was previously redeemed successfully | `400 consumed` |
| `superseded` | A newer verification email was issued; this token is dead-on-arrival | `400 superseded` |
| `expired` | TTL elapsed before the user clicked | `400 expired` |
| `invalid` | Token does not exist or fails structural validation | `400 invalid` |

Distinguishing `superseded` from `consumed` matters: when a user clicks **Resend verification**, every still-open token for that user is marked `superseded` (`invalidateOpenTokens`) and a fresh one is issued. Old links stop working immediately, and clicking a stale email reports `superseded` rather than the misleading `consumed` — which would suggest the user (or someone else) had already verified via that link. The resend endpoint enforces a 1-per-minute debounce plus a 5-per-hour abuse cap per user.

---

## Input Validation

All external input is validated using Zod schemas before processing:

| Input Type | Validation |
|---|---|
| **Email** | `z.string().email()` |
| **UUIDs** | `z.string().uuid()` |
| **Phone numbers** | E.164 regex (`^\+[1-9]\d{6,14}$`) |
| **MFA codes** | Exact 6-character length |
| **Passwords** | 8-128 chars with complexity requirements |
| **Pagination** | `min: 1, max: 100` limit enforcement |
| **Agent messages** | Zod discriminated union for WebSocket payloads |
| **API request bodies** | `@hono/zod-validator` middleware on every route |

Validation errors return structured error objects with field paths. Sensitive values are never echoed in error responses.

---

## HTTP Security Headers

Every response includes the following security headers:

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Content-Security-Policy:
    default-src 'self';
    script-src 'self' 'unsafe-inline';
    style-src 'self' 'unsafe-inline';
    img-src 'self' data: blob:;
    font-src 'self';
    connect-src 'self' ws: wss:;
    frame-ancestors 'none';
    base-uri 'self';
    form-action 'self'
```

### CORS

- **Production**: Only explicitly configured origins allowed via `CORS_ALLOWED_ORIGINS`
- **No wildcards**: Wildcard (`*`) origin is explicitly rejected in production
- **Development**: localhost origins only, excluded from production builds unless opted in
- **Validation**: No `Access-Control-Allow-Origin` header emitted for disallowed origins

### CSRF Protection

State-changing operations (POST, PUT, DELETE) on sensitive endpoints require a `x-breeze-csrf` header. Requests without the header return `403`.

---

## Audit Logging

### What Gets Logged

Every security-relevant operation is recorded in the `audit_logs` table:

| Field | Description |
|---|---|
| `actorType` | `user`, `api_key`, `agent`, or `system` |
| `actorId` | UUID of the actor |
| `action` | Specific operation (e.g., `device.command.execute`) |
| `resourceType` | Target entity type |
| `resourceId` | Target entity UUID |
| `result` | `success`, `failure`, or `denied` |
| `ipAddress` | Source IP (IPv4/IPv6) |
| `userAgent` | Client identifier |
| `details` | JSONB metadata (command type, exit codes, etc.) |
| `errorMessage` | Failure reason (if applicable) |

Client IPs in audit logs are derived via `getTrustedClientIp()`, which only honors `CF-Connecting-IP` / `X-Forwarded-For` / `X-Real-IP` headers when the immediate TCP peer matches a CIDR in `TRUSTED_PROXY_CIDRS`. Forwarded headers from untrusted hops are ignored entirely, and in production with proxy-header trust enabled but no CIDRs configured, the trust list defaults to loopback only — never silently honoring arbitrary upstreams. This makes audit IP attribution accurate even behind multi-layer proxies (Cloudflare → Caddy → API) and prevents a malicious client from spoofing forwarded headers to forge the recorded source IP.

### Retention

- **Default**: 365 days per organization
- **Configurable**: Per-org retention policies via `audit_retention_policies`
- **Archival**: Optional S3 archival before deletion

### Logging Modes

- **Synchronous**: `createAuditLog()` — blocks until written (critical operations)
- **Asynchronous**: `createAuditLogAsync()` — fire-and-forget (non-critical operations)

### Audit Baseline Controls

Breeze enforces event-log audit-policy baselines with continuous drift detection:

- Baseline definitions are stored per-org and per-OS (`audit_baselines`)
- Endpoint policy snapshots are ingested as evidence (`audit_policy_states`)
- Compliance evaluations persist score + deviations (`audit_baseline_results`)
- Security events are emitted for deviations and remediations:
  - `compliance.audit_deviation`
  - `compliance.audit_remediated`

Baseline remediation commands (`apply_audit_policy_baseline`) are treated as privileged operations and must pass RBAC checks (`devices:write`) before execution.

---

## Incident Response Automation

Breeze now includes a structured incident lifecycle API with auditable transitions:

- **Lifecycle states**: `detected` -> `analyzing` -> `contained` -> `recovering` -> `closed`
- **Evidence chain**: evidence entries record who collected it, when, where it is stored, and optional integrity hash
- **Containment governance**: high-risk actions (`network_isolation`, `account_disable`, `usb_block`) require an `approvalRef`
- **Timeline integrity**: incident timeline entries are appended for creation, containment, evidence collection, closure, and SLA escalation
- **Eventing**: `incident.created`, `incident.contained`, `incident.escalated`, and `incident.closed` are emitted for downstream automations and integrations
- **Auditability**: all mutating incident endpoints emit structured route audit events with actor identity and action metadata

Core endpoints are exposed under `/api/v1/incidents/*` for creation, triage, containment, evidence handling, closure, and report generation.

---

## AI Risk Classification

The AI brain has access to powerful tools. Every AI-initiated action passes through a risk classification engine **enforced by the RMM, not the AI**.

| Risk Level | Behavior | Examples |
|---|---|---|
| **Low** | Auto-execute, logged | Query devices, read logs, generate reports |
| **Medium** | Execute + notify technician | Read-only scripts, pre-approved patch deployments |
| **High** | Requires human approval | State-changing scripts, patches outside maintenance windows |
| **Critical** | Blocked entirely | Device wipe, bulk destructive operations |

- Risk policies are configurable per partner, organization, site, or device group
- The AI cannot bypass the risk engine — it is enforced at the tool execution layer
- BYOK mode: your API key, your data, your infrastructure — nothing sent to LanternOps unless you opt in

---

## Infrastructure Security

### Docker Hardening

| Control | Implementation |
|---|---|
| **Base image** | `node:20-alpine` (minimal attack surface) |
| **Multi-stage build** | `deps → builder → runner` (no build tools in production) |
| **Non-root execution** | Dedicated `hono` user (UID 1001), `nodejs` group (GID 1001) |
| **File ownership** | `--chown=hono:nodejs` on all copied assets |
| **Minimal exposure** | Single port (3001) exposed |

### TLS Termination

Caddy reverse proxy handles TLS termination with:

- Automatic Let's Encrypt certificate provisioning (ACME)
- HSTS with preload
- zstd and gzip compression
- Separate routing for `/api/*`, `/metrics/*`, and frontend assets

Full setup guide: [TLS_SETUP.md](TLS_SETUP.md)

### Environment Isolation

- API server listens on localhost — never directly exposed
- Database and Redis accessible only within the Docker network
- Metrics endpoint (`/metrics/*`) separated from public routes

---

## Supply Chain Security

### Automated Scanning

| Scanner | What It Checks | Trigger |
|---|---|---|
| **CodeQL** | Static analysis (SAST) for JS/TS vulnerabilities | Every push and PR to main |
| **Gitleaks** | Hardcoded secrets in source code | Every push and PR to main |
| **npm audit** | Node.js dependency vulnerabilities (high+) | Every push and PR to main + weekly |
| **govulncheck** | Go dependency vulnerabilities | Every push and PR to main + weekly |
| **Trivy** | Filesystem CVE scan (high + critical) | Every push and PR to main + weekly |

All scanners run in CI and **block merges** on failure.

### Dependency Management

- **Lock file**: `pnpm-lock.yaml` committed for reproducible builds
- **Package manager**: pnpm with strict dependency resolution
- **Version pinning**: All dependencies pinned to exact versions via lock file

---

## Secret Management

### Required Secrets

| Secret | Purpose | Minimum Strength |
|---|---|---|
| `JWT_SECRET` | Access/refresh token signing (HS256) | 32+ characters |
| `SESSION_SECRET` | Session token signing | 32+ characters |
| `APP_ENCRYPTION_KEY` | AES-256-GCM encryption for application secrets (`enc:v1:`/`enc:v2:`) | 32-byte hex |
| `MFA_ENCRYPTION_KEY` | AES-256-GCM encryption for TOTP shared secrets (`mfa:v1:`) | 32-byte hex |
| `ENROLLMENT_KEY_PEPPER` | Server-side pepper for SHA-256 enrollment-key hashes | 32+ characters |
| `MFA_RECOVERY_CODE_PEPPER` | Server-side pepper for SHA-256 recovery-code hashes | 32+ characters |
| `AGENT_ENROLLMENT_SECRET` | Shared secret presented at agent enrollment | 32-byte hex |
| `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` | Base64 SPKI Ed25519 key(s) used to verify signed agent release manifests; **required when `BINARY_SOURCE=github` in production** — the API config validator refuses to boot without it | base64 SPKI |
| `BREEZE_PLATFORM_ADMINS` | Optional. Comma-separated email allowlist applied on startup to bootstrap `users.is_platform_admin`. Without it, no user has cross-tenant admin access. | n/a |

### Production Enforcement

Breeze validates environment configuration on startup:

- Rejects 24 known placeholder/default values
- Requires explicit `CORS_ALLOWED_ORIGINS` (no wildcards)
- Enforces minimum secret strength
- Logs warnings for non-critical misconfigurations

#### Migration / deprecation gates

A small set of environment flags exist as one-release migration aids during cross-cutting hardening waves. Each flag has a forward-looking default; operators are expected to retire them within one release of upgrading.

| Flag | Behavior | Status |
|---|---|---|
| `ENROLLMENT_SECRET_ENFORCEMENT_MODE` | When set to `warn`, the enrollment endpoint logs a warning instead of rejecting requests that lack a configured `AGENT_ENROLLMENT_SECRET` (or per-key secret). Default is `enforce`. Use only for the single release immediately following the upgrade, then remove. | Deprecation aid — to be removed after operators migrate |
| `AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET` | Defaults to `false`. Inbound automation webhooks require HMAC signing (`x-breeze-signature` + `x-breeze-timestamp`). Set to `true` as a short-term emergency rollback while migrating legacy `x-automation-secret` / `x-webhook-secret` senders; the flag will be removed in a future release. The `?secret=` query-string path has been removed entirely — no flag re-enables it. | HMAC-only by default; legacy header is opt-in escape hatch |
| `SSO_EXCHANGE_RETURN_REFRESH_TOKEN` | Defaults to `false`: the SSO exchange endpoint delivers the refresh token only via the HttpOnly `breeze_refresh_token` cookie. Set to `true` to also include `refreshToken` in the JSON body for legacy external SSO clients that read it directly. The flag (and the JSON field) will be removed entirely after the Sunset date (2026-08-01). | Opt-in only; removal scheduled |

### Secret Rotation

Comprehensive rotation procedures are documented for 16 secret categories with defined intervals:

| Category | Rotation Interval |
|---|---|
| JWT secrets | 90 days |
| Encryption keys | Annually |
| Database credentials | 90 days |
| Redis credentials | 90 days |
| API provider keys | 90 days |
| Agent enrollment secret | 90 days |

Full rotation runbook: [SECRET_ROTATION.md](SECRET_ROTATION.md)

### Secrets Never Stored in Plaintext

The following are always hashed or encrypted before persistence:

- User passwords (Argon2id)
- Session tokens (SHA-256)
- API keys (SHA-256)
- Agent auth tokens (SHA-256)
- Enrollment keys (SHA-256 with `ENROLLMENT_KEY_PEPPER`)
- MFA recovery codes (SHA-256 with `MFA_RECOVERY_CODE_PEPPER`)
- MFA TOTP secrets (AES-256-GCM under `MFA_ENCRYPTION_KEY`, `mfa:v1:` format)
- Application secrets — SSO client secrets, webhook signing keys, integration credentials (AES-256-GCM under `APP_ENCRYPTION_KEY`, `enc:v1:`/`enc:v2:` format)

---

## Operational Security

### Backup & Recovery

- **RTO**: < 1 hour
- **RPO**: < 15 minutes (with WAL archiving) or last backup interval
- **Components**: PostgreSQL, object storage (MinIO/S3), encrypted configuration
- **Encryption**: Config backups encrypted at rest using OpenSSL

Full procedures: [BACKUP_RESTORE.md](BACKUP_RESTORE.md)

### Disaster Recovery

Five documented failure scenarios with step-by-step recovery:

1. Single service crash
2. Database failure
3. Complete infrastructure loss
4. Data corruption
5. Security incident

Full runbook: [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md)

### Error Handling

- Generic error messages returned to clients — internal details never exposed
- No stack traces in production responses
- Structured JSON logging (`LOG_JSON=true`) for log aggregation
- Optional Sentry integration for error tracking (`SENTRY_DSN`)
- Sensitive data (tokens, passwords) never logged

---

## Vulnerability Disclosure

We follow coordinated disclosure. See [SECURITY.md](../SECURITY.md) for:

- How to report vulnerabilities
- Response timelines (48-hour acknowledgment, severity-based fix targets)
- Scope and disclosure policy

**Email**: [security@lanternops.io](mailto:security@lanternops.io)

---

## SOC 2 Alignment

Breeze's security controls align with SOC 2 Trust Service Criteria:

### CC6 — Logical and Physical Access Controls

| Criteria | Breeze Implementation |
|---|---|
| CC6.1 — Logical access security | JWT + MFA + RBAC + API key scoping |
| CC6.2 — Credentials management | Argon2id passwords, SHA-256 token hashing, AES-256-GCM secrets |
| CC6.3 — Access authorization | Role-based permissions, scope enforcement, `requirePermission()` middleware |
| CC6.6 — External access restrictions | CORS allowlist, CSP, rate limiting, CSRF protection |
| CC6.7 — Data transmission security | TLS 1.2+, HSTS preload, WSS for agent communication |
| CC6.8 — Unauthorized access prevention | Fail-closed rate limiting, device quarantine, session invalidation |

### CC7 — System Operations

| Criteria | Breeze Implementation |
|---|---|
| CC7.1 — Infrastructure monitoring | Agent health checks, heartbeat monitoring, configurable alerting |
| CC7.2 — Anomaly detection | Rate limit violation tracking, audit log analysis |
| CC7.3 — Vulnerability management | CodeQL SAST, Trivy CVE scanning, npm audit, govulncheck |
| CC7.4 — Incident response | Disaster recovery runbook, security incident procedures |

### CC8 — Change Management

| Criteria | Breeze Implementation |
|---|---|
| CC8.1 — Change authorization | PR-based workflow, CI gate enforcement, code review requirements |

### CC9 — Risk Mitigation

| Criteria | Breeze Implementation |
|---|---|
| CC9.1 — Risk identification | Automated security scanning (5 scanners), AI risk classification engine |
| CC9.2 — Vendor risk management | Dependency lock files, supply chain scanning, known vulnerability databases |

### A1 — Availability

| Criteria | Breeze Implementation |
|---|---|
| A1.1 — Processing capacity | Redis-backed rate limiting, BullMQ queue management |
| A1.2 — Recovery objectives | RTO < 1 hour, RPO < 15 minutes |
| A1.3 — Recovery testing | Documented procedures for 5 failure scenarios |

### C1 — Confidentiality

| Criteria | Breeze Implementation |
|---|---|
| C1.1 — Confidential data identification | Multi-tenant isolation, encryption key hierarchy |
| C1.2 — Confidential data disposal | Audit log retention policies, S3 archival, configurable retention |

---

## Security Controls Summary

| Domain | Controls | Status |
|---|---|---|
| Authentication | JWT + MFA + Sessions + API Keys | Implemented |
| Authorization | RBAC + Scope-based multi-tenancy | Implemented |
| Encryption (at rest) | AES-256-GCM, Argon2id, SHA-256 | Implemented |
| Encryption (in transit) | TLS 1.2+ / HSTS / WSS | Implemented |
| Rate limiting | Redis sliding window (fail-closed) | Implemented |
| Audit logging | Structured, org-scoped, async-capable | Implemented |
| Input validation | Zod schemas on all external input | Implemented |
| Security headers | CSP, HSTS, X-Frame-Options, Permissions-Policy | Implemented |
| CORS | Strict allowlist, no production wildcards | Implemented |
| CSRF protection | Header-based validation on state changes | Implemented |
| Agent security | Token hashing + optional mTLS + file permissions | Implemented |
| AI safety | Risk classification engine with human approval gates | Implemented |
| Supply chain | 5 automated scanners blocking on failure | Implemented |
| Docker hardening | Multi-stage, non-root, Alpine base | Implemented |
| Secret management | Rotation procedures, production validation, no plaintext | Implemented |
| Disaster recovery | Documented runbooks, defined RTO/RPO | Implemented |

---

*Last updated: May 2026 (v0.65.0 cross-cutting hardening release)*

*For questions about Breeze security practices, contact [security@lanternops.io](mailto:security@lanternops.io).*
