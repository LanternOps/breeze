# Breeze Customer Launch Security Readiness

Date: 2026-05-24
Reviewer: Codex acting as outside security/launch consultant

## Determination

**No-go for broad customer launch today.**

Breeze has a substantially better security posture than a typical early-stage RMM project: JWT/session handling, agent token design, RLS-backed tenant isolation, MFA gates on many dangerous actions, production deployment hardening, audit logs, and a deep prior remediation trail are all present. I did not find evidence of a simple cross-tenant data break in the areas reviewed.

The no-go is driven by launch-class control failures, not polish:

1. Current staged changes weaken production configuration validation and make existing production validation tests fail.
2. Device inventory and grouping routes have incomplete RBAC/site-scope enforcement.
3. SSO still returns refresh tokens in JSON by default during token exchange.
4. Current npm production audit reports one high advisory in the mobile dependency tree.

I would allow a tightly controlled internal/friendly pilot only after fixing items 1 and 2, with SSO JSON refresh tokens disabled and no customer admin accounts beyond trusted operators.

## Insurance Answer

I would **not insure or underwrite a broad MSP customer launch as-is** based on this code state.

After the launch blockers below are fixed, I would reconsider for a limited production launch if the live deployment is reviewed, CI is green, backups/restore are proven, alerting and incident response are operational, and a focused external pentest covers authz, agent enrollment, command execution, remote access, and tenant isolation.

## Scope

Reviewed high-risk launch surfaces:

- API auth, session, MFA, refresh-token, API-key, and SSO paths.
- Tenant isolation and RLS plumbing.
- Agent enrollment, agent auth, agent command-result binding.
- Remote access and desktop connect-code handling.
- Device routes, scripts, system tools, and command execution controls.
- Production config/deploy defaults and security CI signals.
- Current staged/uncommitted changes relevant to launch risk.

## Launch Blockers

### 1. Production config validation was weakened

Severity: **High**

Current staged changes to `apps/api/src/config/validate.ts` remove production checks that existing tests still expect. The failing tests cover bootstrap admin defaults, malformed/weak/reused encryption keys, missing release artifact manifest public keys, trusted proxy CIDR validation, explicit `IS_HOSTED`, agent enrollment secret, enrollment key pepper, and MFA recovery-code pepper.

Evidence:

- `apps/api/src/config/validate.ts:85` now lists only `CORS_ALLOWED_ORIGINS`, `FORCE_HTTPS`, and `TRUST_PROXY_HEADERS` as production-oriented optional fields before the new LLM config.
- `apps/api/src/config/validate.ts:136` only enforces E2E mode, placeholder required secrets, JWT length, CORS, and explicit trust-proxy flag in production.
- `apps/api/src/config/validate.ts:241` downgrades missing `AGENT_ENROLLMENT_SECRET` to a warning.
- `deploy/docker-compose.prod.yml:95` still requires the removed envs in the production template, including `ENROLLMENT_KEY_PEPPER`, `MFA_RECOVERY_CODE_PEPPER`, release manifest keys, `IS_HOSTED`, and `TRUSTED_PROXY_CIDRS`.
- `apps/api/src/routes/auth/register.ts:195` uses `isHosted()` to decide whether a new partner starts `pending` or `active`; `apps/api/src/config/env.ts:11` defaults missing `IS_HOSTED` to false.

Verification:

- `pnpm --filter @breeze/api exec vitest --run src/config/validate.test.ts` failed: 22 failed, 36 passed.
- Running the full API test command accidentally exercised 433 files and failed only on this config validation file: 22 failed, 4588 passed, 28 skipped.

Required fix before customer launch:

- Restore production validation for encryption-key format/entropy/reuse, required peppers, agent enrollment secret policy, release manifest public keys, trusted proxy CIDRs, explicit `IS_HOSTED`, and bootstrap admin defaults.
- Keep the new `MCP_LLM_*` validation, but merge it without deleting launch guards.
- Make `src/config/validate.test.ts` green.

### 2. Device RBAC/site-scope enforcement is incomplete

Severity: **High**

Device routes inconsistently enforce permissions. High-risk command and remote-access routes are mostly guarded, but many inventory, details, metrics, hardware, software, events, sessions, patch history, and device-group mutation routes only require an authenticated tenant scope. That means any active user in an accessible org can read or mutate device management metadata even if their role lacks `devices:read` or `devices:write`. Site restrictions are also bypassed on routes that never call `requirePermission`, because permissions are not loaded into request context.

Evidence:

- `apps/api/src/routes/devices/core.ts:118` applies `authMiddleware` globally.
- `apps/api/src/routes/devices/core.ts:218` lists devices with `requireScope` but no `requirePermission(PERMISSIONS.DEVICES_READ...)`.
- `apps/api/src/routes/devices/core.ts:529` reads device details with `requireScope` but no device read permission.
- `apps/api/src/routes/devices/core.ts:800` reads management posture with `requireScope` only.
- `apps/api/src/routes/devices/core.ts:822` updates a device with `requireScope` and schema validation but no `devices:write` permission or MFA.
- `apps/api/src/routes/devices/core.ts:866` lets the update path merge `customFields`; those fields feed the remote-access launcher.
- `apps/api/src/routes/devices/core.ts:710` properly gates remote launcher URLs with remote-access permission and MFA, showing the intended pattern.
- `apps/api/src/routes/devices/groups.ts:59`, `:133`, `:219`, `:264`, and `:341` create/update/delete/change group membership with `requireScope` but no explicit device write permission or MFA.
- `apps/api/src/routes/devices/software.ts:15`, `hardware.ts:13`, `metrics.ts:165`, `events.ts:53`, `eventlogs.ts:25`, and `sessions.ts:34` expose detailed inventory/telemetry/session data with `requireScope` only.
- `apps/api/src/routes/devices/helpers.ts:35` and `:51` check org access, not role permission or site assignment.
- `apps/api/src/middleware/auth.ts:456` shows `requirePermission` is the middleware that loads `permissions` into context.

Required fix before customer launch:

- Add a shared device route guard pattern:
  - Read routes: `requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action)`.
  - Write/group/metadata routes: `requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action)` and MFA for sensitive changes.
  - Destructive routes: `requirePermission(PERMISSIONS.DEVICES_DELETE...)` plus MFA.
  - Execute routes: keep `DEVICES_EXECUTE` plus MFA.
- Centralize device lookup to enforce org and site restrictions after permissions are loaded.
- Add tests for roles without `devices:read`, roles without `devices:write`, and users restricted to a different site.

### 3. Device destructive lifecycle lacks MFA

Severity: **Medium-High**

Device decommission, restore, and permanent delete require `devices:delete`, but they do not require MFA. Permanent delete may also send a best-effort self-uninstall command to an online agent.

Evidence:

- `apps/api/src/routes/devices/core.ts:945` soft-deletes/decommissions with delete permission but no MFA.
- `apps/api/src/routes/devices/core.ts:983` restores with delete permission but no MFA.
- `apps/api/src/routes/devices/core.ts:1021` permanently deletes with delete permission but no MFA.
- `apps/api/src/routes/devices/core.ts:1038` can send `SELF_UNINSTALL` as part of permanent delete.

Required fix before customer launch:

- Require MFA for all three lifecycle routes.
- Consider an explicit confirmation phrase or delayed/two-step path for permanent delete/self-uninstall.

### 4. SSO token exchange returns refresh token in JSON by default

Severity: **Medium**

SSO exchange correctly sets an HttpOnly refresh cookie, but by default it also returns the refresh token in the JSON response until the configured sunset. That weakens the browser-side token model for SSO users.

Evidence:

- `apps/api/src/routes/sso.ts:999` sets the refresh cookie.
- `apps/api/src/routes/sso.ts:1005` defaults `SSO_EXCHANGE_RETURN_REFRESH_TOKEN` to true.
- `apps/api/src/routes/sso.ts:1017` includes `refreshToken` in JSON when that flag is true.

Verification:

- `pnpm --filter @breeze/api exec vitest --run src/routes/sso.test.ts` passed: 15 passed.

Required fix before customer launch:

- Set `SSO_EXCHANGE_RETURN_REFRESH_TOKEN=false` in production now.
- Prefer flipping the default to false before onboarding any SSO customer.

### 5. Current production audit reports a high advisory

Severity: **Medium**

`pnpm audit --prod --audit-level=high` reports GHSA-2p57-rm9w-gvfp in `ip <=2.0.1`, via the React Native mobile dependency chain.

Verification:

- `pnpm audit --audit-level=critical` exited successfully with no criticals, but reported 8 total advisories.
- `pnpm audit --prod --audit-level=high` failed: 5 production advisories, including 1 high.

Required fix before broad launch:

- Decide whether the mobile app is in the customer launch scope.
- If yes, upgrade or isolate the vulnerable chain.
- If no, document that mobile is excluded from the launch artifact and CI release gate.

## Positive Findings

- JWT access/refresh split is reasonable: short access TTL, refresh rotation, revocation checks, issuer/audience/type validation.
- Refresh token cookie CSRF checks, origin checks, and rotation are present in the local login path.
- MFA is required on many sensitive actions, including scripts execution, remote access launch, system tools mutating paths, API key create/rotate/delete, and agent token rotation.
- API key auth hashes keys, rejects wildcard scopes, rate-limits pre-lookup probes, validates active tenants, and applies org-scoped RLS context.
- Agent auth compares token hashes with `timingSafeEqual`, supports token rotation windows, checks device state, role-scopes agent/watchdog/helper tokens, and applies org-scoped RLS context.
- Agent enrollment has rate limits, hashed enrollment keys, optional per-key/global secret checks, production fail-closed default, and hostname collision protection.
- Remote desktop/connect-code handling uses one-time Redis-backed grants where reviewed and mints viewer-scoped JWTs instead of full user tokens.
- RLS plumbing uses `DATABASE_URL_APP` when available and applies `breeze.scope`, accessible org IDs, partner IDs, and user ID via request-scoped transactions.
- The production compose/Caddy path is meaningfully hardened: digest-pinned images, Redis not host-published, secrets support, local-only observability ports, and trusted proxy CIDR pinning.
- Focused auth/agent-control tests passed:
  - `pnpm --filter @breeze/api exec vitest --run src/middleware/auth.test.ts src/middleware/apiKeyAuth.test.ts src/routes/devices/core.remoteAccessLaunch.test.ts src/routes/devices/commands.test.ts src/routes/devices/scripts.test.ts`: 5 files passed, 90 passed, 1 skipped.
  - `pnpm --filter @breeze/api exec vitest --run src/services/llm/historyBuilder.test.ts`: 9 passed.
  - `cd agent && go test -race ./...`: passed.
  - `cd agent && govulncheck ./...`: no called vulnerabilities found.

## Launch Conditions

Before launching real MSP customers, require all of these:

1. Restore production config validation and make `src/config/validate.test.ts` green.
2. Close the device RBAC/site-scope class of bugs and add negative tests.
3. Add MFA to device decommission/restore/permanent-delete paths.
4. Set `SSO_EXCHANGE_RETURN_REFRESH_TOKEN=false` and flip the code default when possible.
5. Resolve or explicitly exclude the mobile high advisory from launch scope.
6. Run and record green CI for API, web, agent race tests, audit, CodeQL, gitleaks, and container scanning.
7. Run `pnpm db:check-drift` against the production migration path and confirm RLS coverage tests against the same role model used in production.
8. Prove backup restore, log/alert routing, emergency access, agent revoke/rotation, and customer offboarding in a rehearsal.
9. Keep OAuth/MCP/AI tool execution disabled or tightly allowlisted for first customer launch unless those surfaces are separately pentested.

## Bottom Line

This is close enough to be worth finishing, but not close enough to launch customers today. The project has a strong security foundation; the remaining blockers are specific and fixable. I would re-review after the config validation regression and device RBAC/site-scope issues are fixed.
