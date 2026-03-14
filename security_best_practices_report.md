# Security Best Practices Review Report

Date: 2026-03-03
Repository: /Users/toddhebebrand/breeze
Reviewer mode: `$security-best-practices`

## Executive Summary

I performed multiple security review passes across backend (Node/TypeScript API), frontends (web/portal), helper desktop app (Tauri/Rust), Go agent, and production dependency advisories.

High-confidence findings: **7 total**
- Critical: 1
- High: 3
- Medium: 3
- Low: 0

Most urgent risk is agent bearer-token exposure via world-readable config permissions.

## Method (Multi-Pass)

1. Language/framework pass and targeted security-guidance mapping.
2. Static pattern pass (authn/authz/csrf/cors/xss/ssrf/command-execution/token storage).
3. Backend route-guard consistency pass (scope vs permission vs MFA).
4. Desktop helper and Go agent secret-handling pass.
5. Dependency advisory pass via `pnpm audit --prod --json`.
6. Follow-up confirmation pass for all candidate findings to remove false positives.

## Critical Findings

### F-001: Agent auth token is written to a world-readable file
Severity: Critical

Evidence:
- [/Users/toddhebebrand/breeze/agent/internal/config/config.go:212](/Users/toddhebebrand/breeze/agent/internal/config/config.go:212) writes `auth_token` into `agent.yaml`.
- [/Users/toddhebebrand/breeze/agent/internal/config/config.go:242](/Users/toddhebebrand/breeze/agent/internal/config/config.go:242) sets `agent.yaml` to `0644`.
- [/Users/toddhebebrand/breeze/agent/internal/config/config.go:295](/Users/toddhebebrand/breeze/agent/internal/config/config.go:295) re-applies `0644` at startup.

Impact:
- Any local user/process can read the bearer token and impersonate the agent against API endpoints.

Recommended fix:
- Do not store `auth_token` in world-readable `agent.yaml`.
- Keep token only in root-restricted secrets storage (`0600`) and expose needed helper functionality through privileged IPC, not raw token disclosure.
- Change `agent.yaml` permission model away from `0644` where secrets may exist.

## High Findings

### F-002: Device command-execution routes lack fine-grained RBAC/MFA enforcement
Severity: High

Evidence (representative):
- Permission model defines execute permission: [/Users/toddhebebrand/breeze/apps/api/src/services/permissions.ts:185](/Users/toddhebebrand/breeze/apps/api/src/services/permissions.ts:185).
- Middleware supports permission and MFA checks: [/Users/toddhebebrand/breeze/apps/api/src/middleware/auth.ts:369](/Users/toddhebebrand/breeze/apps/api/src/middleware/auth.ts:369), [/Users/toddhebebrand/breeze/apps/api/src/middleware/auth.ts:402](/Users/toddhebebrand/breeze/apps/api/src/middleware/auth.ts:402).
- Command-capable routes with `requireScope(...)` but no `requirePermission(...DEVICES_EXECUTE...)` / `requireMfa()`:
  - [/Users/toddhebebrand/breeze/apps/api/src/routes/devices/commands.ts:23](/Users/toddhebebrand/breeze/apps/api/src/routes/devices/commands.ts:23), [/Users/toddhebebrand/breeze/apps/api/src/routes/devices/commands.ts:96](/Users/toddhebebrand/breeze/apps/api/src/routes/devices/commands.ts:96)
  - [/Users/toddhebebrand/breeze/apps/api/src/routes/devices/diagnose.ts:12](/Users/toddhebebrand/breeze/apps/api/src/routes/devices/diagnose.ts:12), [/Users/toddhebebrand/breeze/apps/api/src/routes/devices/diagnose.ts:32](/Users/toddhebebrand/breeze/apps/api/src/routes/devices/diagnose.ts:32)
  - [/Users/toddhebebrand/breeze/apps/api/src/routes/devices/filesystem.ts:135](/Users/toddhebebrand/breeze/apps/api/src/routes/devices/filesystem.ts:135), [/Users/toddhebebrand/breeze/apps/api/src/routes/devices/filesystem.ts:341](/Users/toddhebebrand/breeze/apps/api/src/routes/devices/filesystem.ts:341)
  - [/Users/toddhebebrand/breeze/apps/api/src/routes/devices/bootMetrics.ts:93](/Users/toddhebebrand/breeze/apps/api/src/routes/devices/bootMetrics.ts:93), [/Users/toddhebebrand/breeze/apps/api/src/routes/devices/bootMetrics.ts:234](/Users/toddhebebrand/breeze/apps/api/src/routes/devices/bootMetrics.ts:234)
  - [/Users/toddhebebrand/breeze/apps/api/src/routes/devices/patches.ts:295](/Users/toddhebebrand/breeze/apps/api/src/routes/devices/patches.ts:295), [/Users/toddhebebrand/breeze/apps/api/src/routes/devices/patches.ts:393](/Users/toddhebebrand/breeze/apps/api/src/routes/devices/patches.ts:393)
- Contrast: high-risk route groups do enforce permission+MFA:
  - [/Users/toddhebebrand/breeze/apps/api/src/routes/remote/index.ts:12](/Users/toddhebebrand/breeze/apps/api/src/routes/remote/index.ts:12)
  - [/Users/toddhebebrand/breeze/apps/api/src/routes/systemTools/index.ts:19](/Users/toddhebebrand/breeze/apps/api/src/routes/systemTools/index.ts:19)

Impact:
- Users with broad scope but insufficient role privilege can still trigger sensitive endpoint actions on managed devices.

Recommended fix:
- Add `requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action)` and `requireMfa()` to command-executing device routes.
- Apply at route-group level for non-GET methods to avoid drift.

### F-003: Web dashboard persists access tokens in `localStorage`
Severity: High

Evidence:
- Zustand persistence includes `tokens`: [/Users/toddhebebrand/breeze/apps/web/src/stores/auth.ts:85](/Users/toddhebebrand/breeze/apps/web/src/stores/auth.ts:85).
- Access token is then used directly as bearer token: [/Users/toddhebebrand/breeze/apps/web/src/stores/auth.ts:264](/Users/toddhebebrand/breeze/apps/web/src/stores/auth.ts:264).

Impact:
- Any XSS in the web origin can exfiltrate bearer tokens and take over sessions.

Recommended fix:
- Keep access token in memory only; do not persist to `localStorage`.
- Rely on HttpOnly refresh cookie rotation path for session continuity.

## Medium Findings

### F-004: Helper desktop URL allowlist check is bypassable (`starts_with`)
Severity: Medium

Evidence:
- URL validation uses string prefix check: [/Users/toddhebebrand/breeze/apps/helper/src-tauri/src/lib.rs:272](/Users/toddhebebrand/breeze/apps/helper/src-tauri/src/lib.rs:272).
- Bearer token is attached to outbound request: [/Users/toddhebebrand/breeze/apps/helper/src-tauri/src/lib.rs:309](/Users/toddhebebrand/breeze/apps/helper/src-tauri/src/lib.rs:309).

Why this is bypassable:
- Prefix matching can be tricked by crafted URLs like `https://trusted.example.com.evil.tld/...` or `https://trusted.example.com@evil.tld/...`.

Impact:
- If attacker-controlled input reaches this URL field, helper can send authenticated requests to attacker infrastructure.

Recommended fix:
- Parse both configured base URL and request URL; compare normalized scheme/host/port (and optionally enforce path prefix), not raw string prefix.

### F-005: FORCE_HTTPS redirect depends solely on `x-forwarded-proto`
Severity: Medium

Evidence:
- Redirect only occurs when header equals `http`: [/Users/toddhebebrand/breeze/apps/api/src/middleware/security.ts:77](/Users/toddhebebrand/breeze/apps/api/src/middleware/security.ts:77).

Impact:
- If proxy headers are absent or spoofed/misconfigured, expected HTTPS enforcement can silently fail.

Recommended fix:
- Derive protocol from trusted proxy context and fail-safe redirect logic.
- Treat missing/invalid forwarded-proto as non-HTTPS when FORCE_HTTPS is enabled.

### F-006: Swagger UI uses external CDN assets without integrity and persists auth
Severity: Medium

Evidence:
- External scripts/styles from unpkg: [/Users/toddhebebrand/breeze/apps/api/src/routes/docs.ts:27](/Users/toddhebebrand/breeze/apps/api/src/routes/docs.ts:27), [/Users/toddhebebrand/breeze/apps/api/src/routes/docs.ts:102](/Users/toddhebebrand/breeze/apps/api/src/routes/docs.ts:102), [/Users/toddhebebrand/breeze/apps/api/src/routes/docs.ts:103](/Users/toddhebebrand/breeze/apps/api/src/routes/docs.ts:103).
- `persistAuthorization: true`: [/Users/toddhebebrand/breeze/apps/api/src/routes/docs.ts:118](/Users/toddhebebrand/breeze/apps/api/src/routes/docs.ts:118).

Impact:
- Docs sessions may retain credentials in browser storage; external script supply chain risk exists when docs UI is enabled.

Recommended fix:
- Self-host Swagger assets or pin with SRI hashes.
- Disable `persistAuthorization` outside isolated local development.

## Dependency Advisory Findings

### F-007: Production dependency vulnerabilities require upgrade triage
Severity: Medium

Evidence:
- `pnpm audit --prod --json` on 2026-03-03 reported: high=16, moderate=4, low=4.
- High/medium advisories affecting shipped apps include:
  - `@astrojs/node` (<9.5.4) in web/portal: `GHSA-cj9f-h6r6-4cx2`, `GHSA-qq67-mvv5-fw3g`, `GHSA-jm64-8m5q-4qh8`.
  - `minimatch` high advisories in transitive chain impacting `apps/api` (`resend` -> `@react-email/render` -> `js-beautify` -> `glob/editorconfig`).

Impact:
- Known vulnerable dependency graph remains in production scope.

Recommended fix:
- Upgrade `@astrojs/node` to `>=9.5.4` in both web and portal.
- Refresh transitive chains for `minimatch` and other high advisories via lockfile update and targeted package bumps.
- Re-run `pnpm audit --prod --json` and track to zero high/moderate where feasible.

## Notes / Non-Findings

- Mobile app token storage is using `expo-secure-store` (not localStorage/plain AsyncStorage), which is aligned with best practice.
- Webhook sender SSRF hardening appears strong (HTTPS only, private-range blocking, DNS checks, redirect disabled).

## Suggested Remediation Order

1. F-001 (agent token file permissions/exposure)
2. F-002 (RBAC+MFA gaps on device execution routes)
3. F-003 (remove web token persistence)
4. F-004/F-006 (helper URL validation and docs hardening)
5. F-007 dependency upgrade pass
6. F-005 HTTPS enforcement hardening

