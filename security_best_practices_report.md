# Security Best Practices Report

## Executive Summary
Review date: **February 22, 2026**.

This assessment found **0 critical**, **2 high**, and **1 medium** security gaps across the TypeScript API and Go agent. The highest-priority issue is that the agent writes a reusable authentication token to a world-readable config file. The second major issue is missing API-wide request body size enforcement, which increases denial-of-service exposure.

## Scope
- `/Users/toddhebebrand/breeze/apps/api`
- `/Users/toddhebebrand/breeze/apps/web`
- `/Users/toddhebebrand/breeze/apps/portal`
- `/Users/toddhebebrand/breeze/agent`
- `/Users/toddhebebrand/breeze/tools/remote-mcp`

## Findings

### High

#### [HIGH-001] Agent auth token is stored in a world-readable file
- Severity: **High**
- Rule mapping: `GO-SECRETS-001` / least-privilege secret storage
- Location:
  - `/Users/toddhebebrand/breeze/agent/internal/config/config.go:180`
  - `/Users/toddhebebrand/breeze/agent/internal/config/config.go:201`
  - `/Users/toddhebebrand/breeze/agent/internal/config/config.go:207`
  - `/Users/toddhebebrand/breeze/agent/internal/config/config.go:219`
  - `/Users/toddhebebrand/breeze/agent/internal/config/config.go:220`
  - `/Users/toddhebebrand/breeze/agent/internal/config/config.go:242`
  - `/Users/toddhebebrand/breeze/agent/internal/config/config.go:246`
- Evidence:
  - `auth_token` is persisted to `agent.yaml`.
  - Directory permissions are set to `0755` and file permissions are set to `0644`.
  - Startup permission repair keeps the same `0755/0644` model.
- Impact: Any local non-privileged user on the host can read the token and impersonate the agent to the control plane.
- Recommended fix:
  1. Store secrets with least privilege (`0600` file, `0700` dir where possible).
  2. If helper access is required, use a dedicated OS group and `0640` instead of world-readable.
  3. Prefer moving long-lived agent secrets to OS secret storage (Keychain/DPAPI/libsecret) and keep config file non-secret.

#### [HIGH-002] API does not enforce a global request body size limit
- Severity: **High**
- Rule mapping: `EXPRESS-DOS-001` / input size hard limits
- Location:
  - `/Users/toddhebebrand/breeze/apps/api/src/index.ts:170`
  - `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/login.ts:42`
  - `/Users/toddhebebrand/breeze/apps/api/src/routes/remote/transfers.ts:404`
  - `/Users/toddhebebrand/breeze/apps/api/src/routes/remote/transfers.ts:419`
  - `/Users/toddhebebrand/breeze/apps/api/src/routes/remote/transfers.ts:426`
  - `/Users/toddhebebrand/breeze/apps/api/src/routes/automations.ts:794`
- Evidence:
  - Global middleware stack has no body-size limiter.
  - Public JSON endpoints (for example login and webhook routes) rely on parsing request bodies without a central cap.
  - Multipart chunk upload reads full body/chunk into memory before rejecting on total-size checks.
- Impact: Attackers can send oversized payloads to trigger memory/CPU pressure and reduce API availability.
- Recommended fix:
  1. Add API-wide request size limits for JSON and multipart bodies.
  2. Enforce early `Content-Length` ceilings and streaming limits per route.
  3. Apply stricter per-endpoint limits for unauthenticated/public routes.

### Medium

#### [MED-001] Automation webhook accepts secrets in URL query strings and uses direct string comparison
- Severity: **Medium**
- Rule mapping: `EXPRESS-SECRETS-001` / webhook secret handling
- Location:
  - `/Users/toddhebebrand/breeze/apps/api/src/routes/automations.ts:786`
  - `/Users/toddhebebrand/breeze/apps/api/src/routes/automations.ts:788`
  - `/Users/toddhebebrand/breeze/apps/api/src/routes/automations.ts:790`
- Evidence:
  - Webhook secret is accepted from `?secret=...` query parameters.
  - Secret validation uses direct string inequality (`providedSecret !== trigger.secret`).
- Impact: Query-parameter secrets are more likely to leak through logs/proxies, and direct comparison is weaker than constant-time secret checks.
- Recommended fix:
  1. Remove query-string secret support and accept secrets only in dedicated headers.
  2. Compare secrets with `timingSafeEqual` after length checks.
  3. Add route-specific rate limiting and minimum secret entropy validation.

## Positive Controls Observed
- Cookie-authenticated flows use CSRF token + origin/fetch-site validation and constant-time token comparison:
  - `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/helpers.ts:187`
  - `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/helpers.ts:205`
  - `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/helpers.ts:226`
- Webhook URL validation includes SSRF-focused checks (HTTPS-only, private-range block, DNS resolution checks):
  - `/Users/toddhebebrand/breeze/apps/api/src/services/notificationSenders/webhookSender.ts:125`
  - `/Users/toddhebebrand/breeze/apps/api/src/services/notificationSenders/webhookSender.ts:150`
  - `/Users/toddhebebrand/breeze/apps/api/src/services/notificationSenders/webhookSender.ts:175`
- Production config validation blocks insecure placeholders and wildcard CORS:
  - `/Users/toddhebebrand/breeze/apps/api/src/config/validate.ts:83`
  - `/Users/toddhebebrand/breeze/apps/api/src/config/validate.ts:100`

## Secure-by-Default Improvement Plan
1. Remove world-readable agent secret storage (`0600`/secret-store migration).
2. Introduce centralized body-size limits and per-route caps for public endpoints.
3. Harden webhook authentication: header-only secrets, constant-time compare, and rate limiting.
