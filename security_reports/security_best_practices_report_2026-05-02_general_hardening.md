# Security Best Practices Review - General Hardening

Date: 2026-05-02
Repository: `/Users/toddhebebrand/breeze`
Reviewer mode: `security-best-practices`

## Executive Summary

I reviewed the existing security documentation, prior remediation reports, CI security workflows, and selected high-risk API/web/agent surfaces. The previous canonical report shows the original tracked findings as remediated; this pass found no new critical or high-confidence tenant-isolation bypass.

I did find four actionable hardening items:

- One medium-risk open-redirect/phishing weakness in billing portal return URL handling.
- One medium-risk push notification token logging issue.
- One low-risk CI scanner gap where npm audit is currently advisory-only because the pinned pnpm version is known to use a retired advisory endpoint.
- One low-risk OAuth DCR cleanup gap if dynamic client registration is enabled.

Best next work: fix the two medium findings first because they are small, low-regression changes with clear security value. Then make npm audit blocking again by bumping pnpm and wiring DCR cleanup if MCP OAuth DCR is expected in any production-like environment.

## Method

1. Loaded the project instructions and security-best-practices guidance for TypeScript/React/Node-style web services and Go components.
2. Reviewed previous security reports and the security policy to avoid re-reporting remediated findings.
3. Reviewed app bootstrap, CORS/CSP/body-limit/rate-limit posture, CI scanning workflows, OAuth DCR notes, billing portal forwarding, browser auth helpers, and notification senders.
4. Ran static searches for high-risk sinks: token storage, bearer injection, raw HTML, redirects, outbound fetch, command execution, path joins, secrets, unsafe TODOs, and unauthenticated public surfaces.

Local scanner note: the local shell in this Codex environment does not have `pnpm`, `npm`, `corepack`, or `govulncheck` on `PATH`, so I could not execute a fresh local `pnpm audit` or `govulncheck` run. CI does contain security scanning workflows, reviewed below.

## Medium Findings

### G-001: Billing portal accepts arbitrary return URLs

Rule ID: EXPRESS-REDIRECT-001
Severity: Medium

Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/externalServices.ts:82](/Users/toddhebebrand/breeze/apps/api/src/routes/externalServices.ts:82)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/externalServices.ts:110](/Users/toddhebebrand/breeze/apps/api/src/routes/externalServices.ts:110)
- [/Users/toddhebebrand/breeze/apps/web/src/components/layout/Header.tsx:68](/Users/toddhebebrand/breeze/apps/web/src/components/layout/Header.tsx:68)

Evidence:
- The API schema accepts any syntactically valid URL: `returnUrl: z.string().url()`.
- The validated value is forwarded as `return_url` to the billing service without same-origin or allowlist enforcement.
- The normal web caller sends `window.location.href`, which is same-origin in the current UI flow, but the server-side endpoint does not enforce that contract.

Impact:
- Any authenticated partner user can ask the API to create a billing portal session with an attacker-controlled return URL. If the upstream billing/Stripe flow honors that value, the returned billing link can be used as a trusted Breeze-to-billing-to-attacker redirect chain for phishing or session-confusion attacks.

Fix:
- Validate `returnUrl` server-side against `PUBLIC_APP_URL`, `DASHBOARD_URL`, or `CORS_ALLOWED_ORIGINS`.
- Prefer accepting only same-origin relative paths from the client, then build the absolute return URL server-side.
- Add tests that reject `https://example.com/back` and accept the configured dashboard origin.

Mitigation:
- If the billing service already performs stricter allowlisting, document it and still add API-side validation so the security boundary is visible in this repo.

False positive notes:
- Exploitability depends on the upstream billing service honoring the forwarded `return_url`. The Breeze API currently does not show that protection.

### G-002: APNS stub logs push notification tokens

Rule ID: EXPRESS-CONFIG-001 / GO-CONFIG-001 equivalent secret logging control
Severity: Medium

Location:
- [/Users/toddhebebrand/breeze/apps/api/src/services/notifications.ts:176](/Users/toddhebebrand/breeze/apps/api/src/services/notifications.ts:176)

Evidence:
- `sendAPNS()` logs `{ token, title: payload.title }` while returning a stubbed response.
- Push tokens are bearer-like device identifiers. They should be treated as sensitive operational data because logs are commonly shipped to third-party aggregation and retained longer than application data.

Impact:
- APNS device tokens can leak into API logs whenever mobile notification dispatch hits the APNS path. A log-reader or compromised log sink could harvest device identifiers and correlate users/devices, and in some push systems a token leak can enable unauthorized notification attempts if paired with provider credentials.

Fix:
- Remove the token from the warning or log only a short hash/fingerprint, for example `sha256(token).slice(0, 12)`.
- Add a regression test around `sendAPNS()` or notification dispatch logging if the project has logger test utilities.

Mitigation:
- Review current logs for accidental APNS token exposure if this code has run in a connected environment.

False positive notes:
- This path is currently a stub, but it is production code in the API service and receives real `device.apnsToken` values when called.

## Low Findings

### G-003: npm audit is advisory-only because CI pins pnpm 9.15.0

Rule ID: EXPRESS-DEPENDENCY-001
Severity: Low

Location:
- [/Users/toddhebebrand/breeze/package.json:24](/Users/toddhebebrand/breeze/package.json:24)
- [/Users/toddhebebrand/breeze/.github/workflows/security.yml:15](/Users/toddhebebrand/breeze/.github/workflows/security.yml:15)
- [/Users/toddhebebrand/breeze/.github/workflows/security.yml:47](/Users/toddhebebrand/breeze/.github/workflows/security.yml:47)

Evidence:
- The repo pins `packageManager` to `pnpm@9.15.0`.
- The security workflow also sets `PNPM_VERSION: '9.15.0'`.
- The workflow documents that this pnpm version calls a retired advisory endpoint and leaves `pnpm audit --audit-level=critical` as `continue-on-error: true`.

Impact:
- Critical npm dependency advisories may be visible in logs but will not fail pull requests or scheduled scans. In an RMM product with remote execution and agent update paths, dependency advisory response should be blocking for critical findings.

Fix:
- Bump pnpm to at least the workflow-commented fixed version, update `packageManager`, and remove `continue-on-error`.
- Keep the current Trivy, CodeQL, Dependabot, and gitleaks workflows; they are useful complementary controls.

Mitigation:
- Until the pnpm bump lands, review the weekly security workflow output manually.

False positive notes:
- This is a process/control gap, not an exploitable code path. It is still worth fixing because the workflow explicitly says it is currently advisory-only.

### G-004: OAuth DCR cleanup helper is not scheduled

Rule ID: EXPRESS-DOS-001
Severity: Low

Location:
- [/Users/toddhebebrand/breeze/apps/api/src/config/env.ts:23](/Users/toddhebebrand/breeze/apps/api/src/config/env.ts:23)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/oauth.ts:90](/Users/toddhebebrand/breeze/apps/api/src/routes/oauth.ts:90)
- [/Users/toddhebebrand/breeze/apps/api/src/oauth/provider.ts:36](/Users/toddhebebrand/breeze/apps/api/src/oauth/provider.ts:36)
- [/Users/toddhebebrand/breeze/apps/api/src/oauth/provider.ts:49](/Users/toddhebebrand/breeze/apps/api/src/oauth/provider.ts:49)
- [/Users/toddhebebrand/breeze/apps/api/src/oauth/provider.ts:274](/Users/toddhebebrand/breeze/apps/api/src/oauth/provider.ts:274)

Evidence:
- `OAUTH_DCR_ENABLED` defaults to disabled in production, but can be enabled.
- The route blocks registration only when DCR is disabled.
- The provider enables dynamic registration with `initialAccessToken: false` when DCR is enabled.
- The cleanup helper itself documents that anyone can create a client when DCR is enabled and that the cleanup is not wired into the worker registry.

Impact:
- If production or hosted environments enable DCR, unauthenticated clients can accumulate abandoned OAuth client rows until manual cleanup runs. Rate limiting reduces abuse speed, but the table still grows without a scheduled lifecycle control.

Fix:
- Wire `cleanupStaleOauthClients()` into a daily BullMQ/worker job when MCP OAuth is enabled.
- Consider making production DCR require an initial access token once dashboard issuance exists.

Mitigation:
- Keep `OAUTH_DCR_ENABLED=false` in production until the cleanup is scheduled or externally cron-driven.

False positive notes:
- This is conditional on DCR being enabled. The default production value is safer, but the feature flag exists and the code comments already identify the missing scheduler.

## Positive Controls Observed

- API bootstrap applies secure headers, CSP, request body limits, CORS allowlisting, and global rate limiting.
- Access tokens are no longer persisted in browser local storage; the persisted auth store excludes `tokens`.
- Metrics scraping has a dedicated bearer token path and production redacts org IDs from Prometheus labels by default.
- Security workflows exist for CodeQL, gitleaks, Trivy, npm audit, and Go `govulncheck`.
- Prior reports show substantial remediation coverage across agent result binding, helper output redaction, route authorization, RLS, and queue dedupe issues.

## Suggested Next Work Order

1. Fix G-002 by removing APNS token logging. This is the smallest and lowest-risk code change.
2. Fix G-001 by enforcing same-origin billing portal return URLs in the API and updating tests.
3. Bump pnpm and make `pnpm audit --audit-level=critical` blocking again.
4. Wire OAuth DCR cleanup if DCR is expected outside local development.
5. Continue deeper manual review in these areas: public installer/download endpoints, remote desktop/tunnel ticket lifecycles, AI tool execution approvals, and file browser upload/download path handling.
