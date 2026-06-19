---
name: security-review
description: Comprehensive security review for Breeze RMM. Multi-tenant isolation audit, authentication/authorization hardening, public exploitability assessment, input validation, rate limiting, WebSocket security, secrets management, and OWASP top-10 coverage. Use when reviewing code for security issues, hardening endpoints, auditing tenant isolation, checking for vulnerabilities, or before deploying security-sensitive changes.
---

# Breeze RMM Security Review

Run a structured security audit against the Breeze RMM codebase. This skill covers the full attack surface: API routes, agent communication, multi-tenant isolation, and public-facing endpoints.

## Review Process

The checklist below is the **coverage map**. For high-signal results (low false positives), run it
using the **two-pass fan-out methodology** in [references/methodology.md](references/methodology.md):

1. **(Optional) Pass 0 — threat-model seed** for large diffs: enumerate attack hypotheses per trust
   boundary before reading code.
2. **Pass 1 — generation:** work the checklist with whole-repo data-flow tracing (Grep/Glob/Read,
   not diff-only — cross-file flows are what authz/RLS/SSRF review misses). For focused diffs, fan
   out one sub-agent per vuln class. Over-produce candidates.
3. **Pass 2 — adversarial verification:** launch one parallel sub-agent **per candidate** to re-check
   it read-only against the exclusion list + a 1–10 confidence score; **drop anything < 8.**

Note the **RMM-specific exclusion overrides** in methodology.md: unlike the upstream defaults, missing
audit logs, path-only SSRF in the agent's URL-fetch paths, and agent IPC/file-permission gaps **are**
in scope for Breeze.

Report findings as:

- **CRITICAL** — Exploitable now, data leak or privilege escalation
- **HIGH** — Exploitable with effort or insider access
- **MEDIUM** — Defense-in-depth gap, hardening opportunity
- **LOW** — Best-practice suggestion, no immediate risk
- **PASS** — Pattern verified, no issue found

At the end, produce a summary table of all findings with severity, file, line, and remediation.
For a quick single-pass triage, the checklist alone is fine; for pre-pentest or pre-release reviews,
use the full two-pass flow.

## Checklist

### 1. Multi-Tenant Isolation

The hierarchy is: Partner > Organization > Site > Device Group > Device. Every query touching tenant data MUST be scoped.

See [references/multi-tenant.md](references/multi-tenant.md) for isolation patterns, common bypass vectors, and files to audit.

**Verify:**
- [ ] Every SELECT/UPDATE/DELETE on tenant-scoped tables includes org filtering via `auth.orgCondition()`
- [ ] No route fetches data then post-filters without also having query-level filtering
- [ ] `withSystemDbAccessContext()` is only used for bootstrap operations (enrollment, agent auth lookup)
- [ ] Partner-scope users respect `orgAccess` field (all/selected/none)
- [ ] System-scope routes are protected by `requireScope('system')`
- [ ] Cross-tenant data leaks: check JOIN queries that could return data from other orgs
- [ ] Bulk operations (batch delete, bulk update) enforce per-item org ownership
- [ ] List endpoints with pagination do not leak total counts across tenants

### 2. Authentication and Authorization

See [references/auth-hardening.md](references/auth-hardening.md) for auth patterns and files to audit.

**Verify:**
- [ ] Every route has `authMiddleware` or `agentAuthMiddleware` (except explicitly public routes)
- [ ] Public routes are intentional and documented: `/health`, `/ready`, `/enroll`, login, register
- [ ] JWT `type` claim checked (access vs refresh tokens not interchangeable)
- [ ] Token revocation checked on every request via Redis
- [ ] MFA enforcement where required (`requireMfa()` middleware)
- [ ] `requireScope()` applied to admin/system routes
- [ ] `requirePermission()` applied to sensitive operations
- [ ] Refresh token stored in httpOnly cookie with CSRF protection
- [ ] Password hashing uses bcrypt/argon2 with sufficient rounds
- [ ] Session invalidation on password change
- [ ] API keys: SHA-256 hashed, `brz_` prefix validated, expiry enforced
- [ ] Agent tokens: SHA-256 hashed, device status checked (reject decommissioned/quarantined)

### 3. Input Validation and Injection

**Pattern:** Every route uses `zValidator('param'|'query'|'json', schema)` before the handler.

**Verify:**
- [ ] All route handlers have Zod validation middleware
- [ ] UUIDs validated as `.uuid()` (not raw string)
- [ ] File paths checked for directory traversal (`../`, null bytes)
- [ ] SQL: All queries use Drizzle ORM parameterized queries (no raw SQL string interpolation)
- [ ] XSS: User-supplied strings not rendered as raw HTML in React components
- [ ] Command injection: Any shell invocations use array args, not shell string interpolation
- [ ] SSRF: Any URL inputs validated against allowlist (no internal network access)
- [ ] Array/object size limits in schemas (prevent DoS via large payloads)
- [ ] Enum values validated (no arbitrary strings where enums expected)
- [ ] Agent command payloads validated before dispatch

### 4. Rate Limiting and DoS Protection

**Files to check:**
- `apps/api/src/middleware/globalRateLimit.ts` — Global rate limiter
- `apps/api/src/services/rate-limit.ts` — Sliding window implementation
- Auth routes — Per-endpoint limits

**Verify:**
- [ ] Global rate limit applied to all routes (300/60s default)
- [ ] Auth endpoints have strict limits: login (5/5min), register (5/hr), MFA (5/5min)
- [ ] Rate limiter fails closed (returns 429 if Redis unavailable)
- [ ] Agent rate limit enforced (120/60s per device)
- [ ] API key per-key rate limits configured and enforced
- [ ] No rate limit bypass via header spoofing (`X-Forwarded-For` trusted only from proxy)
- [ ] WebSocket connections rate-limited on upgrade
- [ ] Body size limits enforced (1MB default, exceptions documented)
- [ ] `E2E_MODE` rate limit bypass only in non-production

### 5. WebSocket Security

**Files to check:**
- `apps/api/src/routes/agentWs.ts` — Agent WebSocket
- `apps/api/src/routes/terminalWs.ts` — Terminal sessions
- `apps/api/src/routes/desktopWs.ts` — Remote desktop
- `apps/api/src/services/remoteSessionAuth.ts` — WS ticket system

**Verify:**
- [ ] Agent WS: Token validated before upgrade (not after)
- [ ] User WS: One-time ticket consumed before upgrade (Redis-backed, single-use)
- [ ] Every incoming WS message validated against Zod schema
- [ ] No reflection of untrusted data back to other connections
- [ ] Connection cleanup on disconnect (no memory leaks in connection maps)
- [ ] Ping/pong timeout for stale connections (60s pongWait)
- [ ] Session ownership verified (session.userId === authenticated user)
- [ ] Binary frames only from expected sources (agent to user, not reverse)
- [ ] No auth tokens transmitted over WS after initial handshake

### 6. Secrets and Cryptography

**Files to check:**
- `apps/api/src/services/secretCrypto.ts` — AES-256-GCM encryption
- `apps/api/src/services/enrollmentKeySecurity.ts` — Enrollment key hashing
- `.env` files, `docker-compose*.yml` — Secret configuration

**Verify:**
- [ ] AES-256-GCM with random 12-byte IV (no IV reuse)
- [ ] `APP_ENCRYPTION_KEY` required in production (no fallback to weak keys)
- [ ] Timing-safe comparison (`timingSafeEqual`) for all secret comparisons
- [ ] No secrets in logs (grep for token/key/secret/password in log output)
- [ ] No secrets in error responses returned to clients
- [ ] `.env` files in `.gitignore`
- [ ] Docker secrets not hardcoded in compose files (use env vars)
- [ ] Enrollment keys: peppered hash, usage-limited, time-limited
- [ ] JWT secret sufficient entropy (>= 256 bits)
- [ ] No deprecated crypto (MD5, SHA1 for security, DES, RC4)

### 7. CORS, Headers and Transport

**Files to check:**
- `apps/api/src/index.ts` — CORS config, security headers
- `apps/api/src/services/corsOrigins.ts` — Origin allowlist
- `apps/api/src/middleware/security.ts` — HTTPS enforcement, CSP

**Verify:**
- [ ] CORS origins explicitly allowlisted (no wildcard `*` in production)
- [ ] `credentials: true` only with explicit origins (never with `*`)
- [ ] HSTS enabled with sufficient max-age (>= 1 year) and `includeSubDomains`
- [ ] `X-Frame-Options: DENY` (clickjacking protection)
- [ ] CSP restricts `default-src 'self'`, no `unsafe-eval` in production
- [ ] `Referrer-Policy: strict-origin-when-cross-origin`
- [ ] `Permissions-Policy` disables unused APIs (camera, microphone, geolocation)
- [ ] HTTPS enforced in production (`FORCE_HTTPS=true`, 308 redirect)
- [ ] Secure cookie flags: `httpOnly`, `secure`, `sameSite`

### 8. Agent Communication Security

> For a deep Go-agent pass (update/manifest channel, Helper IPC privilege boundary, command
> injection, Go-language footguns), use [references/agent-go-review.md](references/agent-go-review.md)
> — it carries the priority threat model (manifest-signing-key → fleet-wide RCE as SYSTEM) and the
> SYSTEM-vs-user helper scope checks. The checklist below is the quick version.

**Files to check:**
- `agent/internal/websocket/client.go` — WS client TLS config
- `agent/internal/config/config.go` — Config file permissions
- `agent/internal/mtls/mtls.go` — mTLS certificate handling
- `apps/api/src/routes/agents/enrollment.ts` — Enrollment flow

**Verify:**
- [ ] Agent config file permissions: 0700 dir, 0600 file
- [ ] Agent token stored securely in memory (`secmem.SecureString`)
- [ ] TLS certificate validation enabled (no `InsecureSkipVerify`)
- [ ] mTLS certificates rotated before expiry (2/3 lifetime threshold)
- [ ] Enrollment secret required in production (`AGENT_ENROLLMENT_SECRET`)
- [ ] Enrollment keys single-use or usage-capped
- [ ] Agent commands validated before execution (no arbitrary code execution)
- [ ] Command results sanitized before storage
- [ ] Agent binary integrity verified on update (checksum validation)
- [ ] No plaintext secrets in agent logs

### 9. Public Exploitability Assessment

Evaluate from an external attacker perspective:

**Unauthenticated attack surface:**
- [ ] Enumerate all routes without `authMiddleware` — each must be intentional
- [ ] Login/register: brute-force protected by rate limiting
- [ ] Enrollment: protected by secret + rate limiting
- [ ] Health/ready: no sensitive data leaked
- [ ] Error responses: no stack traces, internal paths, or debug info in production
- [ ] 404 responses: consistent (no path enumeration via timing/content differences)

**Authenticated attacker (compromised user):**
- [ ] Cannot access other tenants' data (org isolation)
- [ ] Cannot escalate scope (org to partner to system)
- [ ] Cannot forge/modify JWT claims
- [ ] Cannot access agent commands for devices outside their org
- [ ] Cannot enumerate users/devices in other orgs
- [ ] Cannot bypass MFA once enabled

**Compromised agent:**
- [ ] Cannot access other agents' data
- [ ] Cannot run commands on other devices
- [ ] Cannot access API routes meant for users
- [ ] Rate-limited to prevent DoS
- [ ] Quarantine mechanism available for compromised devices

**Supply chain / infrastructure:**
- [ ] Dependencies: check for known CVEs (`pnpm audit`, `go mod verify`)
- [ ] Docker images: pinned versions, no `latest` tags in production
- [ ] No dev dependencies in production builds
- [ ] CI/CD: no secrets in build logs

### 10. Data Protection

**Verify:**
- [ ] PII fields identified and encrypted at rest where required
- [ ] Audit logs capture who accessed what (not just mutations)
- [ ] Soft delete vs hard delete: sensitive data properly purged
- [ ] Database backups encrypted
- [ ] Log sanitization: no tokens, passwords, or PII in application logs
- [ ] API responses do not over-expose fields (use select/pick, not SELECT *)
- [ ] Pagination prevents full-table dumps
- [ ] Export/download endpoints scoped and rate-limited

## Output Format

After completing all checks, produce:

```
## Security Review Summary

| # | Severity | Category | File:Line | Finding | Remediation |
|---|----------|----------|-----------|---------|-------------|
| 1 | CRITICAL | ... | ... | ... | ... |

### Statistics
- Critical: X
- High: X
- Medium: X
- Low: X
- Pass: X

### Top Priority Actions
1. ...
2. ...
3. ...
```

For CRITICAL and HIGH findings, include proof-of-concept or reproduction steps.
