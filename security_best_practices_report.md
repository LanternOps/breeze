# Security Best Practices Report (Breeze)

Date: 2026-02-10

## Executive Summary

The codebase has several strong secure-by-default choices (argon2id password hashing, refresh-token rotation with revocation, disabling proxy-header trust in production by default, webhook SSRF defenses, and avoiding `localStorage` persistence for access tokens in the main web app). The highest-risk issue I found is a browser XSS sink (`document.write`) used for a PDF/print export flow, which can enable full account takeover if attacker-controlled device data can reach that HTML.

The next most important gaps are production-hardening issues: the customer portal uses in-memory sessions/reset tokens/rate-limits (easy to bypass in multi-instance deployments), global credentialed CORS is enabled with a permissive default allowlist even in production, and the MCP server can auto-execute destructive tools under `ai:execute` without rate limits.

This report is focused on high-impact, secure-by-default improvements and references concrete code locations in the current workspace.

## Fix Status (Applied in Working Tree)

As of 2026-02-10, the following changes have been applied in this workspace to address the findings:

- [CRIT-001] Removed the `document.write()` sink from the export/print flow: `/Users/toddhebebrand/breeze/apps/web/src/components/devices/DeviceCompare.tsx`.
- [HIGH-001] Moved portal session/reset/rate-limit storage to Redis in production (with dev/test in-memory fallback): `/Users/toddhebebrand/breeze/apps/api/src/routes/portal.ts`.
- [HIGH-002] Tightened CORS to be strict-by-default in production and “no CORS” on disallowed origins (and aligned cookie-CSRF origin checks): `/Users/toddhebebrand/breeze/apps/api/src/services/corsOrigins.ts`, `/Users/toddhebebrand/breeze/apps/api/src/routes/auth.ts`.
- [HIGH-003] Added MCP endpoint rate limiting + Tier 3+ tool allowlist requirement in production: `/Users/toddhebebrand/breeze/apps/api/src/routes/mcpServer.ts`.
- [MED-001] Uses trusted client IP extraction for audit logging: `/Users/toddhebebrand/breeze/apps/api/src/routes/apiKeys.ts`.
- [MED-002] Requires a dedicated encryption key in production (no JWT/session-secret fallback): `/Users/toddhebebrand/breeze/apps/api/src/services/secretCrypto.ts`.
- [MED-003] Redacts webhook URLs in logs (no query/userinfo): `/Users/toddhebebrand/breeze/apps/api/src/services/notificationSenders/webhookSender.ts`.
- [MED-004] Added Fetch Metadata (`Sec-Fetch-Site`) defense-in-depth for cookie-authenticated CSRF checks: `/Users/toddhebebrand/breeze/apps/api/src/routes/auth.ts`.
- [LOW-001] Added secret scanning via Gitleaks in CI: `/Users/toddhebebrand/breeze/.github/workflows/secret-scan.yml`.

## Critical Findings

### [CRIT-001] DOM XSS Risk via `document.write` in Export/Print Flow

Impact: If attacker-controlled data can influence the generated HTML, an admin exporting/printing can run arbitrary JavaScript in the Breeze web origin, enabling account takeover and destructive actions.

Evidence:
- `/Users/toddhebebrand/breeze/apps/web/src/components/devices/DeviceCompare.tsx:762-773` uses `printWindow.document.write(html)` where `html` is generated from device data.

Why this matters:
- `document.write()` is a high-risk DOM XSS sink. In an RMM context, device attributes (hostname, software names, patch names, etc.) often originate from agents and should be treated as untrusted.

Secure-by-default recommendations:
1. Avoid HTML-string injection entirely: build the printable DOM using safe APIs (`document.createElement`, `textContent`) and append nodes.
2. If HTML strings are unavoidable, sanitize with a robust HTML sanitizer (for example DOMPurify configured for a strict allowlist) before insertion.
3. Prefer generating PDFs server-side or using a client-side PDF generator that does not require HTML injection.
4. Add CSP defense-in-depth for the app shell (at edge or Astro adapter) to reduce blast radius if XSS occurs.

## High Findings

### [HIGH-001] Portal Sessions/Reset Tokens/Rate Limits Stored In-Memory (Bypassable in Multi-Instance Prod)

Impact: In horizontally scaled deployments, brute-force protections and session state become inconsistent; attackers can bypass rate limits by spreading requests across instances, and sessions/reset tokens may not validate consistently.

Evidence:
- `/Users/toddhebebrand/breeze/apps/api/src/routes/portal.ts:53-60` stores portal sessions, reset tokens, and rate limit buckets in `Map`.
- Related limits/caps exist, but they are per-process, not global.

Secure-by-default recommendations:
1. Move portal session storage, password reset tokens, and rate limiting to a shared store (Redis) with TTLs and atomic operations.
2. If Redis is not available, enforce rate limits at the edge (WAF/CDN) as a backstop, but do not rely on in-process maps in production.
3. Add per-account and per-IP rate limits that cannot be bypassed by multi-instance routing.

### [HIGH-002] Global Credentialed CORS Enabled with Production Defaults That Still Include Local Origins

Impact: Misconfiguration in production (forgetting to set a strict allowlist) can lead to overly broad cross-origin behavior and increase risk for cookie-authenticated endpoints.

Evidence:
- `/Users/toddhebebrand/breeze/apps/api/src/index.ts:136-145` enables CORS globally with `credentials: true`.
- `/Users/toddhebebrand/breeze/apps/api/src/services/corsOrigins.ts:1-50` default allowlist includes multiple `http://localhost:*` origins and `tauri://localhost`, and always returns a string origin (falls back to `defaultOrigins[0]` when disallowed).

Notes:
- The implementation does not reflect arbitrary origins; it falls back to a fixed default origin. That reduces classic CORS reflection issues, but secure-by-default production posture should be stricter.

Secure-by-default recommendations:
1. In production, require explicit `CORS_ALLOWED_ORIGINS` and consider ignoring the local-default allowlist unless an explicit `ALLOW_LOCAL_ORIGINS=true` flag is set.
2. Prefer returning “no CORS” for disallowed origins (framework-dependent: return `null/undefined/false`) instead of returning a default origin string.
3. Consider scoping credentialed CORS only to route groups that need it (for example auth refresh endpoints) rather than global `*`.

### [HIGH-003] MCP Server Auto-Executes Destructive Tools under `ai:execute` Without Rate Limits

Impact: A leaked or overly-permissive API key can be used to execute destructive actions at machine speed (including Tier 3+ tools) with no interactive approval and without visible rate limiting at the MCP layer.

Evidence:
- `/Users/toddhebebrand/breeze/apps/api/src/routes/mcpServer.ts:319-349` auto-executes tools after scope checks and guardrails.
- `/Users/toddhebebrand/breeze/apps/api/src/routes/mcpServer.ts:64-119` maintains in-memory SSE sessions; `/message` does not show rate limiting in the route.

Secure-by-default recommendations:
1. Add explicit rate limiting for MCP endpoints (`/sse`, `/message`) keyed by API key id and org id.
2. Add a server-side allowlist for Tier 3+ tools per API key (not just broad `ai:execute`) to reduce blast radius.
3. Consider an organization-level kill switch for destructive tool execution (default off), or require “two-man rule” for Tier 4 if present.
4. Ensure guardrails cover SSRF-like inputs, command/script execution, and any filesystem paths.

## Medium Findings

### [MED-001] API Key Audit Logging Trusts Spoofable Forwarded Headers for IP Address

Impact: Audit trails can be spoofed, harming incident response and abuse detection.

Evidence:
- `/Users/toddhebebrand/breeze/apps/api/src/routes/apiKeys.ts:53-76` sets `ipAddress` from `x-forwarded-for` / `x-real-ip` directly, bypassing the repo’s safer `getTrustedClientIp()` approach.

Secure-by-default recommendations:
1. Centralize IP extraction using `/Users/toddhebebrand/breeze/apps/api/src/services/clientIp.ts` and make proxy-header trust explicit.
2. Record both “raw” and “trusted” IPs if needed, but use trusted IP for rate limiting/audit decisions.

### [MED-002] Secret Encryption Key Derives from Multiple Fallback Secrets (Couples Concerns)

Impact: Rotating JWT/session secrets can unintentionally rotate the encryption key for stored secrets, potentially causing data loss (undecryptable secrets) or forcing insecure operational practices (not rotating).

Evidence:
- `/Users/toddhebebrand/breeze/apps/api/src/services/secretCrypto.ts:13-26` derives the encryption key from `APP_ENCRYPTION_KEY || ... || JWT_SECRET || SESSION_SECRET`.

Secure-by-default recommendations:
1. Require a dedicated encryption key (for example `APP_ENCRYPTION_KEY`) in production and avoid fallback to auth secrets.
2. Add explicit key versioning (KMS-style) to support safe rotation without breaking decrypt.

### [MED-003] Webhook Sender Logs Full URL (Potential Credential Leakage)

Impact: If webhook URLs contain credentials or sensitive query params, they may be written to logs.

Evidence:
- `/Users/toddhebebrand/breeze/apps/api/src/services/notificationSenders/webhookSender.ts:294` logs `config.url`.

Secure-by-default recommendations:
1. Log only `hostname` and webhook id/name (or a redacted URL).
2. Strip userinfo/query/fragment before logging.

### [MED-004] Cookie-CSRF Protection Relies on Header Presence (Minimal)

Impact: This is often acceptable as a lightweight “custom header” CSRF mitigation, but it is brittle and easy to misapply if cookie scope changes or CORS settings evolve.

Evidence:
- `/Users/toddhebebrand/breeze/apps/api/src/routes/auth.ts:205-217` requires `x-breeze-csrf` header and checks Origin allowlist.
- `/Users/toddhebebrand/breeze/apps/web/src/stores/auth.ts:95-129` always sends `x-breeze-csrf: 1` for refresh.

Secure-by-default recommendations:
1. Consider implementing a real CSRF token (double-submit cookie or synchronizer token) for cookie-authenticated state-changing endpoints.
2. Add Fetch Metadata checks (`Sec-Fetch-Site`, `Sec-Fetch-Mode`) as defense-in-depth.
3. Ensure Origin checking fails closed when Origin is missing for browser contexts (be careful with non-browser clients).

## Low Findings / Hygiene

### [LOW-001] `.env` Contains Secret Config Locally (Ensure Non-Commit + Scanning)

Notes:
- A local `.env` exists with typical secret-bearing variables (database URLs, JWT secret, provider keys). The repo `.gitignore` already ignores `.env`, which is good.

Secure-by-default recommendations:
1. Add secret scanning in CI (gitleaks/trufflehog) to catch accidental commits.
2. Ensure production uses a secret manager (not `.env` files baked into images).

Evidence:
- `/Users/toddhebebrand/breeze/.gitignore:10-16` ignores `.env` patterns.

## Positive Security Posture (What You’re Already Doing Well)

1. Web app auth avoids persisting access tokens to `localStorage` (access token is recovered via refresh cookie), reducing XSS persistence risk:
   - `/Users/toddhebebrand/breeze/apps/web/src/stores/auth.ts:35-91` persists only `user`.
   - `/Users/toddhebebrand/breeze/apps/web/src/stores/auth.ts:120-212` restores access token via cookie-backed refresh and uses it in memory.
2. Refresh token cookies are scoped and hardened:
   - `/Users/toddhebebrand/breeze/apps/api/src/routes/auth.ts:126-151` sets `HttpOnly; SameSite=Lax; Path=/api/v1/auth` and uses `Secure` in production.
3. Webhook SSRF defenses are present (HTTPS-only, blocks private/localhost, DNS check):
   - `/Users/toddhebebrand/breeze/apps/api/src/services/notificationSenders/webhookSender.ts:101-173`.
4. Agent monitor HTTP client defaults to verifying TLS (`verifySsl` default true), even though it supports an insecure override:
   - `/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_monitor.go:170-183`.

## Suggested Next Steps (Fix Order)

1. Fix [CRIT-001] first (remove `document.write` sink in DeviceCompare export).
2. Decide portal production posture: move portal sessions/reset/rate-limit storage to Redis and/or edge enforcement ([HIGH-001]).
3. Tighten production CORS defaults and scope credentialed CORS to only what’s required ([HIGH-002]).
4. Add MCP endpoint rate limiting and per-tool allowlists for `ai:execute` keys ([HIGH-003]).
5. Reduce logging/audit spoofing/leakage ([MED-001], [MED-003]) and decouple encryption keys ([MED-002]).
