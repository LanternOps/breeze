# Security Review Batch 2 — Findings #2–#10 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the actionable findings (#3, #5, #6, #7, #8, #9, #10) from the May 2026 security review with TDD, and land the quick-win mitigation for the PAM HIGH (#2 Fix A); scope the larger PAM Track-6 builds (#2a, #2b, #4) as a separate design.

**Architecture:** Each finding maps to an independent, individually-shippable PR. No shared state between workstreams except the shared `safeFetch`/`urlSafety` module (PR 3) and the agent `config.go` (PR 2). Work proceeds branch-per-PR off `worktree-security-fixes-batch2`.

**Tech Stack:** Hono + TypeScript (API), Vitest (API tests), Go 1.25 (agent), `go test -race` (agent tests), Drizzle + hand-written SQL migrations + RLS (Postgres).

**Finding #1 is OWNED BY ANOTHER AGENT — out of scope here.** The build-breaker (stray `pl` token in `agent/internal/collectors/command_limits.go:23`) is an *uncommitted working-tree change in the main checkout* and is NOT present in this worktree (branched fresh from origin/main). It must be fixed in the main checkout separately.

---

## Decisions required before implementation (surfaced to user)

RESOLVED by user 2026-05-29:

1. **#3 MFA in production:** ✅ **Warn loudly only** (NOT refuse-to-boot). Fix the misleading warning text + emit an accurate, loud startup/config warning describing the full blast radius. **Do NOT** add the `hasSatisfiedMfa` prod-enforcement branch — that would silently lock out a deliberately-2FA-off self-hosted deploy. No runtime behavior change to the gate; warning accuracy only.
2. **#5 SSRF on-prem:** ✅ **Gate `allowPrivateNetwork` on `IS_HOSTED=false`** — hosted SaaS strict (no RFC1918), self-hosted allows RFC1918 for on-prem appliances. Metadata IPs always blocked.
3. **#6 agent secrets:** suffix-based denylist predicate (recommended, drift-proof, touches 3 fns). **Companion required:** `Load` must read `backup_s3_*` back from secrets.yaml (config.go:265-282) or backup config silently breaks.
4. **#10:** allowlist refactor + regression test (recommended).
5. **PAM (#2/#4):** ✅ keep actuate route flag-OFF in production (PR 6). Defer #2a/#2b/#4 Track-6 builds — design section only; do NOT enable in prod until they land.

---

## PR 1 — Auth hygiene (Findings #9, #10, LOW)

Pure cleanup + regression guard. No active exploit today.

### Task 1.1: Regression test for the agent-auth skip set (#10)

**Files:**
- Modify: `apps/api/src/routes/agents/index.ts:30-43` (export skip sets + refactor regex → exact-match)
- Test: `apps/api/src/routes/agents/agentAuthSkip.test.ts` (create)

Current skip set (verified): `:id`-segment exact matches `enroll`, `renew-cert`, `quarantined`, `org`, `download`; plus regex `/\/[^/]+\/(approve|deny)$/`. The regex is an open-ended suffix → a future nested route ending in `/approve` or `/deny` would inherit the skip.

- [ ] **Step 1: Refactor `index.ts` skip logic to an exact-match allowlist (behavior-preserving) and export it**

```ts
// apps/api/src/routes/agents/index.ts — replace the lines 30-43 middleware
// Sub-paths under /:id/* that handle their own (user-JWT) auth and skip agent-token auth.
export const AGENT_AUTH_SKIP_ID_SEGMENTS = new Set([
  'enroll', 'renew-cert', 'quarantined', 'org', 'download',
]);
// Routes of the exact shape /:id/<action> that use user JWT auth.
export const AGENT_AUTH_SKIP_ACTIONS = new Set(['approve', 'deny']);

export function shouldSkipAgentAuth(path: string, id: string): boolean {
  if (AGENT_AUTH_SKIP_ID_SEGMENTS.has(id)) return true;
  const segments = path.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  const secondLast = segments[segments.length - 2];
  // Only the EXACT shape .../<id>/<action> skips — never a deeper nested path.
  return secondLast === id && AGENT_AUTH_SKIP_ACTIONS.has(last);
}

agentRoutes.use('/:id/*', async (c, next) => {
  if (shouldSkipAgentAuth(c.req.path, c.req.param('id'))) return next();
  return agentAuthMiddleware(c, next);
});
```

- [ ] **Step 2: Write the failing regression test importing the real predicate**

```ts
// apps/api/src/routes/agents/agentAuthSkip.test.ts
import { describe, expect, it } from 'vitest';
import { shouldSkipAgentAuth } from './index';

const SKIPPED: Array<[string, string]> = [
  ['/agents/enroll', 'enroll'],
  ['/agents/renew-cert', 'renew-cert'],
  ['/agents/quarantined', 'quarantined'],
  ['/agents/org/123/settings', 'org'],
  ['/agents/download/agent.msi', 'download'],
  ['/agents/dev-123/approve', 'dev-123'],
  ['/agents/dev-123/deny', 'dev-123'],
];
const ENFORCED: Array<[string, string]> = [
  ['/agents/dev-123/heartbeat', 'dev-123'],
  ['/agents/dev-123/inventory', 'dev-123'],
  ['/agents/dev-123/commands', 'dev-123'],
  ['/agents/dev-123/logs', 'dev-123'],
  // Regression guards: nested paths ending in approve/deny MUST still enforce.
  ['/agents/dev-123/scripts/s-1/approve', 'dev-123'],
  ['/agents/dev-123/scripts/s-1/deny', 'dev-123'],
  // Substring foot-guns must enforce.
  ['/agents/dev-123/approveX', 'dev-123'],
  ['/agents/dev-123/predeny', 'dev-123'],
];

describe('agent-auth skip carve-out', () => {
  it.each(SKIPPED)('SKIPS for %s', (path, id) => {
    expect(shouldSkipAgentAuth(path, id)).toBe(true);
  });
  it.each(ENFORCED)('ENFORCES for %s', (path, id) => {
    expect(shouldSkipAgentAuth(path, id)).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test — confirm it passes against the refactored code**

Run: `pnpm test --filter=@breeze/api -- agentAuthSkip`
Expected: PASS (all SKIPPED true, all ENFORCED false). If you implement the test before the refactor, the nested-approve cases FAIL first.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/agents/index.ts apps/api/src/routes/agents/agentAuthSkip.test.ts
git commit -m "fix(api): close agent-auth skip carve-out to exact-match allowlist + regression test (#10)"
```

### Task 1.2: Delete dead auth middleware (#9)

**Files:**
- Modify: `apps/api/src/middleware/auth.ts` (delete `optionalAuthMiddleware`, lines 57-179; reword comment at :396)
- Modify: `apps/api/src/middleware/apiKeyAuth.ts` (delete `eitherAuthMiddleware`, lines 272-296)
- Modify: `apps/api/src/middleware/apiKeyAuth.test.ts` (remove from destructure :50; delete `describe('eitherAuth middleware', …)` :530-567)

Verified dead: `optionalAuthMiddleware` has zero imports (only def + a comment ref). `eitherAuthMiddleware` has zero production mounts (only its own tests). The barrel uses `export *`, so no barrel edit needed. `eitherAuthMiddleware`'s `await next()` fall-through is an auth bypass if ever mounted standalone — deletion removes the foot-gun.

- [ ] **Step 1: Delete `optionalAuthMiddleware` (auth.ts:57-179) and reword the dangling comment at auth.ts:396**

Change the comment from `(see optionalAuthMiddleware note).` to `(see the withDbAccessContext call below).`

- [ ] **Step 2: Delete `eitherAuthMiddleware` (apiKeyAuth.ts:272-296) and its tests (apiKeyAuth.test.ts:50 destructure + :530-567 describe block)**

- [ ] **Step 3: Type-check + run the middleware tests to confirm no dangling refs**

Run: `cd apps/api && npx tsc --noEmit && pnpm test -- apiKeyAuth auth.test`
Expected: PASS, no "eitherAuthMiddleware/optionalAuthMiddleware is not defined" errors. (Note: pre-existing unrelated test errors in `agents.test.ts`/`apiKeyAuth.test.ts` per memory — confirm only those, no new ones.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/middleware/auth.ts apps/api/src/middleware/apiKeyAuth.ts apps/api/src/middleware/apiKeyAuth.test.ts
git commit -m "chore(api): delete dead optionalAuthMiddleware + eitherAuthMiddleware (auth bypass foot-gun) (#9)"
```

---

## PR 2 — Agent config secrets (Findings #6, #8, MEDIUM/LOW)

Go agent only. Invariant to preserve: **agent.yaml stays 0644/Users-readable** (Helper reads it, #988); **secrets.yaml is the 0600 locked file**. Never re-tighten agent.yaml. `helper_auth_token` MUST remain in agent.yaml.

**Files:**
- Modify: `agent/internal/config/config.go` (strip-list :489-497, `isSecretConfigKey` :565-572, `migrateInlineSecretsToSecretFile` :627-663, secrets chmod :477-479, `Load` read-back :265-282)
- Test: `agent/internal/config/config_test.go` (extend)

### Task 2.1: Replace strip-list with a drift-proof secret-key predicate (#6)

Verified 5-key allowlist: `auth_token`, `watchdog_auth_token`, `mtls_cert_pem`, `mtls_key_pem`, `mtls_cert_expires`. Missing: `backup_s3_access_key`, `backup_s3_secret_key`. The list is duplicated in 3 places.

- [ ] **Step 1: Write failing table-driven test for the predicate**

```go
// config_test.go
func TestIsSecretYAMLKey(t *testing.T) {
	cases := map[string]bool{
		"auth_token": true, "watchdog_auth_token": true,
		"mtls_cert_pem": true, "mtls_key_pem": true, "mtls_cert_expires": true,
		"backup_s3_access_key": true, "backup_s3_secret_key": true,
		"smtp_password": true, "some_token": true,
		"helper_auth_token": false, // intentionally kept in agent.yaml
		"server_url": false, "agent_id": false,
		"backup_s3_bucket": false, "backup_s3_region": false,
	}
	for key, want := range cases {
		if got := isSecretYAMLKey(key); got != want {
			t.Errorf("isSecretYAMLKey(%q) = %v, want %v", key, got, want)
		}
	}
}
```

- [ ] **Step 2: Run it — confirm it fails (function undefined)**

Run: `cd agent && go test ./internal/config/ -run TestIsSecretYAMLKey`
Expected: FAIL (build error / undefined `isSecretYAMLKey`).

- [ ] **Step 3: Implement the predicate and route all 3 sites through it**

```go
// config.go — add (requires "strings" import)
var secretKeyAllowedInAgentYAML = map[string]bool{
	"helper_auth_token": true, // Breeze Assist runs as the logged-in user; must read it.
}

func isSecretYAMLKey(key string) bool {
	if secretKeyAllowedInAgentYAML[key] {
		return false
	}
	switch key {
	case "auth_token", "watchdog_auth_token",
		"mtls_cert_pem", "mtls_key_pem", "mtls_cert_expires":
		return true
	}
	return strings.HasSuffix(key, "_token") ||
		strings.HasSuffix(key, "_secret_key") ||
		strings.HasSuffix(key, "_access_key") ||
		strings.HasSuffix(key, "_secret") ||
		strings.HasSuffix(key, "_password")
}
```

Then: `stripSecretsFromAgentConfig` iterates `values` keys, deletes those where `isSecretYAMLKey(key)`. `isSecretConfigKey` (:565) becomes `return isSecretYAMLKey(key)`. `migrateInlineSecretsToSecretFile` (:627-663) iterates loaded keys and tests `isSecretYAMLKey` instead of the static slice.

- [ ] **Step 4: Run TestIsSecretYAMLKey — confirm PASS**

Run: `cd agent && go test -race ./internal/config/ -run TestIsSecretYAMLKey`
Expected: PASS.

- [ ] **Step 5: Write + run the agent.yaml regression test (the leak this fixes)**

```go
func TestSaveToStripsBackupS3SecretsFromAgentYAML(t *testing.T) {
	defer viper.Reset()
	dir := t.TempDir()
	// seed agent.yaml inline with backup_s3 secrets, Load, SaveTo, assert stripped.
	// (mirror existing TestMigrateInlineSecretsToSecretFileScrubsAgentYAML)
	// Assert: agent.yaml no longer contains backup_s3_secret_key value;
	//         secrets.yaml DOES contain it; helper_auth_token STILL in agent.yaml.
}
```

Run: `cd agent && go test -race ./internal/config/ -run TestSaveToStripsBackupS3`
Expected: PASS.

- [ ] **Step 6: Companion — `Load` must read `backup_s3_*` back from secrets.yaml (config.go:265-282)**

If `backup_s3_*` now migrate into secrets.yaml, `Load`'s secrets read-back (currently only `auth_token`/`watchdog_auth_token`/`helper_auth_token`/`mtls_*`) must include them, or backup config silently breaks. Add them. (DECISION 3 companion — required if adopting migration.)

- [ ] **Step 7: Commit**

```bash
git add agent/internal/config/config.go agent/internal/config/config_test.go
git commit -m "fix(agent): drift-proof secret-key strip predicate (catches backup_s3_*) (#6)"
```

### Task 2.2: Make secrets.yaml chmod failure fatal (#8)

Verified: secrets chmod enforce at config.go:477-479 is warn-only; agent.yaml/dir enforce at :441-446 is warn-only (correct — leave it). Callers: enrollment `main.go:1015` → `os.Exit` on `SaveTo` error; runtime mTLS renewal `heartbeat.go:2359/2420` logs + retries. So returning an error is the right propagation.

- [ ] **Step 1: Write failing test (injectable chmod) — DECISION needed: make `enforceSecretFilePermissions` a package `var` for test override**

```go
func TestSaveToFailsWhenSecretsChmodFails(t *testing.T) {
	defer viper.Reset()
	orig := enforceSecretFilePermissions
	defer func() { enforceSecretFilePermissions = orig }()
	enforceSecretFilePermissions = func(string) error { return errors.New("boom") }
	// ... set up cfg with a secret, call SaveTo, assert error wraps the secrets path.
}
```

- [ ] **Step 2: Run — confirm fail (currently SaveTo returns nil)**

Run: `cd agent && go test ./internal/config/ -run TestSaveToFailsWhenSecretsChmod`
Expected: FAIL.

- [ ] **Step 3: Change config.go:477-479 to return the error**

```go
if err := enforceSecretFilePermissions(secretsPath); err != nil {
	return fmt.Errorf("enforcing secrets file permissions on %s: %w", secretsPath, err)
}
```

Make `enforceSecretFilePermissions` a package-level `var` so the test can override it. Leave config.go:441-446 (agent.yaml/dir) warn-only.

- [ ] **Step 4: Run — confirm PASS; also run the invariant guards**

Run: `cd agent && go test -race ./internal/config/...`
Expected: PASS, including existing `TestEnforceConfigPermissionsAreHelperReadable` (agent.yaml still 0644) and `TestSaveToWritesAtomicallyWithoutLeftoverTempFiles`.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/config/config.go agent/internal/config/config_test.go
git commit -m "fix(agent): fatal on secrets.yaml chmod-enforce failure; agent.yaml stays warn-only (#8)"
```

---

## PR 3 — SSRF in DNS-provider sync (Finding #5, MEDIUM)

Verified: `requestJson` (`apps/api/src/services/dnsProviders/http.ts:55`) uses raw `fetch()`; config-time `checkSsrfSafe` is a static string check (no DNS pin, vulnerable to rebind → 169.254.169.254 / RFC1918). Peer paths use `safeFetch` (`apps/api/src/services/urlSafety.ts`) which resolves + pins. **Constraint:** pihole + adguard_home are `on-prem-http` providers that legitimately need RFC1918 — `safeFetch` must gain an opt-in that allows RFC1918 but STILL blocks metadata/loopback/link-local.

**Files:**
- Modify: `apps/api/src/services/urlSafety.ts` (add `allowPrivateNetwork` opt-in + `isAlwaysBlockedIp`)
- Modify: `apps/api/src/services/dnsProviders/http.ts` (route through `safeFetch`, thread `allowPrivateNetwork`)
- Modify: `apps/api/src/services/dnsProviders/pihole.ts`, `adguardHome.ts` (pass `allowPrivateNetwork: true`)
- Test: `apps/api/src/services/dnsProviders/http.test.ts` (create), `apps/api/src/services/urlSafety.test.ts` (extend)

### Task 3.1: Add on-prem opt-in to `safeFetch`

- [ ] **Step 1: Write failing tests in urlSafety.test.ts for `isAlwaysBlockedIp`/`isRfc1918OrUla`**

Assert: `169.254.169.254` → always blocked; `10.0.0.5`/`192.168.1.1`/`172.16.0.1`/`fd12::1` → allowed when on-prem; `100.64.0.1` (CGNAT)/`127.0.0.1`/`fe80::1` → always blocked.

- [ ] **Step 2: Run — confirm fail (functions undefined)**

Run: `pnpm test --filter=@breeze/api -- urlSafety`
Expected: FAIL.

- [ ] **Step 3: Implement `isRfc1918OrUla` (subset of existing matchers) + `isAlwaysBlockedIp` + `allowPrivateNetwork?: boolean` on `SafeFetchInit`; select predicate at the literal-IP check (:136) and resolved-record filter (:156)**

```ts
const block = init.allowPrivateNetwork ? isAlwaysBlockedIp : isPrivateIp;
```

`isAlwaysBlockedIp(ip)` = `isPrivateIp(ip) ? !isRfc1918OrUla(ip) : false`. `isRfc1918OrUla` matches only 10/8, 192.168/16, 172.16-31/12, IPv6 fc/fd — NOT 169.254, 127, 100.64, 0/8, multicast.

- [ ] **Step 4: Run urlSafety tests — PASS**

Run: `pnpm test --filter=@breeze/api -- urlSafety`
Expected: PASS.

### Task 3.2: Route `requestJson` through `safeFetch` + opt in on-prem providers

- [ ] **Step 1: Write failing http.test.ts** using `__setLookupForTests` DNS hook (as in urlSafety.test.ts):
  - strict mode: `requestJson('https://attacker.example/x')` with lookup→`169.254.169.254` (and `10.0.0.5`, etc.) → `rejects.toBeInstanceOf(SsrfBlockedError)`.
  - literal metadata URL rejected without DNS.
  - `allowPrivateNetwork: true` + lookup→`10.0.0.5` → proceeds (local http server returns `{}`).
  - **`allowPrivateNetwork: true` + lookup→`169.254.169.254` → STILL rejects** (key assertion).
  - on-prem opt-in: `127.0.0.1`/`100.64.0.1` still rejected.

- [ ] **Step 2: Run — confirm fail**

Run: `pnpm test --filter=@breeze/api -- dnsProviders/http`
Expected: FAIL (raw fetch doesn't block).

- [ ] **Step 3: Replace `fetch` at http.ts:55 with `safeFetch(String(input), { ...fetchInit, timeoutMs, allowPrivateNetwork, signal, headers })`; add `allowPrivateNetwork?` to `RequestJsonInit`. Keep the retry loop (note `SsrfBlockedError` is not a `TypeError`, so it fails fast — correct).**

- [ ] **Step 4: Opt in pihole.ts + adguardHome.ts gated on deployment (DECISION 2 RESOLVED):** pass `allowPrivateNetwork: !config.IS_HOSTED` — hosted SaaS gets strict behavior (no RFC1918), self-hosted allows it for on-prem appliances. Thread `IS_HOSTED` from the `createDnsProvider` factory in `index.ts:36` into the pihole/adguard provider classes (they don't take config today). Cloudflare/DnsFilter/Umbrella leave it unset (strict). Metadata IPs blocked regardless.

- [ ] **Step 5: Run all PR-3 tests — PASS**

Run: `pnpm test --filter=@breeze/api -- dnsProviders urlSafety`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/urlSafety.ts apps/api/src/services/dnsProviders/
git commit -m "fix(api): route DNS-provider sync through safeFetch with on-prem opt-in; block metadata/rebind SSRF (#5)"
```

---

## PR 4 — access_reviews dual-axis RLS (Finding #7, LOW/MED)

Verified: `access_reviews` has nullable `org_id` AND nullable `partner_id` (both single-col FKs). Partner-axis rows (`org_id=NULL`) have org-only Shape-1 policies → `breeze_has_org_access(NULL)=FALSE` → app-layer-only filter (fail-closed, no leak) → violates the "no app-layer-only RLS" invariant. **Pure policy change, no schema change** (rows are org XOR partner, so no composite FK applies — mutual exclusivity is app-layer; an optional CHECK is out of scope).

**Files:**
- Create: `apps/api/migrations/2026-05-29-access-reviews-dual-axis-rls.sql`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (add `access_reviews` to `DUAL_AXIS_TENANT_TABLES`, line ~95)

### Task 4.1: Forward migration converting to Shape-4 dual-axis policies

- [ ] **Step 1: Write the idempotent migration**

```sql
-- 2026-05-29-access-reviews-dual-axis-rls.sql
-- Finding #7: access_reviews carries org_id (org-axis) AND partner_id
-- (partner-axis) rows but shipped org-only Shape-1 policies, so partner-axis
-- rows (org_id=NULL) fell back to an app-layer-only filter (fail-closed, no
-- leak) — violating the no-app-layer-only-RLS invariant. Convert to Shape-4
-- dual-axis (org OR partner). Mirrors deployment_invites (2026-04-20-b) /
-- users. Axes are mutually exclusive, so no composite FK applies.
-- Idempotent: DROP POLICY IF EXISTS then recreate. No inner BEGIN/COMMIT.
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.access_reviews;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.access_reviews;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.access_reviews;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.access_reviews;
DROP POLICY IF EXISTS breeze_dual_axis_select ON public.access_reviews;
DROP POLICY IF EXISTS breeze_dual_axis_insert ON public.access_reviews;
DROP POLICY IF EXISTS breeze_dual_axis_update ON public.access_reviews;
DROP POLICY IF EXISTS breeze_dual_axis_delete ON public.access_reviews;
CREATE POLICY breeze_dual_axis_select ON public.access_reviews FOR SELECT
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_insert ON public.access_reviews FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_update ON public.access_reviews FOR UPDATE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_delete ON public.access_reviews FOR DELETE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
```

- [ ] **Step 2: Add `access_reviews` to `DUAL_AXIS_TENANT_TABLES` in rls-coverage test** (do NOT add to `ORG_AXIS_POLICY_EXCLUDED_TABLES` — the dual-axis policy still references `breeze_has_org_access`, so the org-tenant test continues to pass).

- [ ] **Step 3: Run the migration locally + the RLS contract test (needs real DB)**

Run: `pnpm db:check-drift` (policies aren't drizzle-tracked → expect no drift), then `pnpm test --filter=@breeze/api -- rls-coverage.integration`
Expected: PASS (dual-axis + org-tenant tests green with access_reviews).

- [ ] **Step 4: Verify as `breeze_app` — forge cross-tenant inserts**

`docker exec -it breeze-postgres psql -U breeze_app -d breeze`; set partner-scoped GUCs; partner-A partner-axis insert SUCCEEDS, partner-B FAILS with `new row violates row-level security policy`; org-axis regression also checked. (Full SQL in investigation notes.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-05-29-access-reviews-dual-axis-rls.sql apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "fix(api,rls): access_reviews partner-axis rows get dual-axis RLS, not app-layer-only (#7)"
```

> **Behavioral note:** this likely changes partner-scoped runtime behavior from "returns nothing under RLS" to "returns the partner's rows." Smoke the partner-scoped GET `/access-reviews` after deploy.

---

## PR 5 — Accurate, loud warning when MFA is globally disabled (Finding #3, MEDIUM)

Verified: `hasSatisfiedMfa` (`apps/api/src/middleware/auth.ts:620-623`) `if (!ENABLE_2FA) return true` → every `requireMfa()` gate (~230 call sites incl. admin/abuse, tenant export/erasure, remote access, PAM, backups) becomes a no-op when `ENABLE_2FA=false`. The warning (`schemas.ts:11-13`) misstates impact ("All MFA endpoints return 404") and there's no prod guard.

**DECISION 1 RESOLVED: warn loudly only — do NOT refuse boot, do NOT change the gate's runtime behavior.** Rationale: a self-hosted operator may deliberately run 2FA-off; refusing boot OR enforcing the gate in prod (forcing all gated routes to 403) would lock them out. The fix is accuracy: the warning must correctly state that disabling 2FA neuters EVERY `requireMfa()` gate, not just `/auth/mfa` endpoints. **No `hasSatisfiedMfa` prod-enforcement branch.**

**Files:**
- Modify: `apps/api/src/routes/auth/schemas.ts:11-13` (correct + loud warning text)
- Modify: `apps/api/src/config/validate.ts` (add accurate non-fatal `collectWarnings` entry; NO `superRefine` refusal)
- Test: `apps/api/src/config/validate.test.ts` (extend — warning emitted, NOT throws)

### Task 5.1: Correct the misleading startup warning

- [ ] **Step 1: Rewrite the warning at `schemas.ts:11-13`** to accurately describe blast radius (keep it a guarded `console.warn`, suppressed under `NODE_ENV==='test'` as today):

```ts
if (!ENABLE_2FA && process.env.NODE_ENV !== 'test') {
  console.warn(
    '[auth] WARNING: ENABLE_2FA=false. This disables ALL requireMfa() step-up ' +
    'gates across the API (admin/abuse, tenant export/erasure, remote device ' +
    'control, sensitive-data, API keys, SSO, backups/DR) — not just the ' +
    '/auth/mfa endpoints. Do not use this configuration in production.',
  );
}
```

- [ ] **Step 2: Commit (no behavior change — text only)** — combined with Task 5.2.

### Task 5.2: Accurate non-fatal config-validator warning (NOT a boot refusal)

- [ ] **Step 1: Write failing test in validate.test.ts** using the existing `makeBaseEnv()`/`validateConfig` harness:
  - prod + `ENABLE_2FA=false` → `validateConfig` **succeeds** (does NOT throw) and `collectWarnings` includes an `ENABLE_2FA` warning mentioning "requireMfa" + "not just /auth/mfa".
  - prod + `ENABLE_2FA=true` / unset → no such warning.

- [ ] **Step 2: Run — confirm fail (no warning emitted yet)**

Run: `pnpm test --filter=@breeze/api -- validate`
Expected: FAIL.

- [ ] **Step 3: Add `ENABLE_2FA: z.string().optional()` to schema + env passthrough; add a `collectWarnings` entry (NOT a `superRefine` issue):**

```ts
if (['false', '0', 'no', 'off'].includes((env.ENABLE_2FA ?? '').trim().toLowerCase())) {
  warnings.push({
    key: 'ENABLE_2FA',
    message:
      'ENABLE_2FA=false disables ALL requireMfa() step-up gates (admin/abuse, ' +
      'tenant export/erasure, remote access, API keys, SSO, backups) — not just ' +
      'the /auth/mfa endpoints. Strongly discouraged in production.',
  });
}
```

- [ ] **Step 4: Run validate + full auth suite — PASS; confirm `register.test.ts` (sets ENABLE_2FA:false under NODE_ENV=test) still green and nothing now throws**

Run: `pnpm test --filter=@breeze/api -- auth validate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/schemas.ts apps/api/src/config/validate.ts apps/api/src/config/validate.test.ts
git commit -m "fix(api): accurate loud warning that ENABLE_2FA=false neuters ALL requireMfa gates (#3)"
```

---

## PR 6 — PAM actuate route OFF in production (Finding #2 Fix A, HIGH quick mitigation)

Verified: `status='approved'` is unreachable via any API today (only `'pending'` is set), so the actuator is inert (every actuate call 409s). The danger is the moment Track 6 lands an approval path WITHOUT #2a/#2b. Quick win: gate the route default-OFF, mirroring `devPush.ts:48-56`.

**Files:**
- Modify: `apps/api/src/routes/devices/actuateElevation.ts` (add env guard after authMiddleware :25)
- Test: `apps/api/src/routes/devices/actuateElevation.test.ts` (extend)

- [ ] **Step 1: Write failing test** — with `PAM_ACTUATOR_ENABLED` unset, POST returns **403** and `db.transaction` is NOT called; with `='true'`, route proceeds (wrap existing tests under the flag). Save/restore env per test.

- [ ] **Step 2: Run — confirm fail**

Run: `pnpm test --filter=@breeze/api -- actuateElevation`
Expected: FAIL (no guard yet).

- [ ] **Step 3: Add the guard**

```ts
actuateElevationRoutes.use('*', async (c, next) => {
  if (process.env.PAM_ACTUATOR_ENABLED !== 'true') {
    return c.json({ error: 'PAM actuator is disabled' }, 403);
  }
  return next();
});
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/devices/actuateElevation.ts apps/api/src/routes/devices/actuateElevation.test.ts
git commit -m "fix(api): gate PAM actuate route OFF by default until JIT creds + target re-validation land (#2)"
```

---

## Track 6 — PAM full hardening (Findings #2a, #2b, #4) — DESIGN ONLY, separate PRs

These are larger builds with open product decisions; NOT fully task-stepped here. Keep `PAM_ACTUATOR_ENABLED` OFF in production until they land.

### #2b — Agent-side live-target re-validation (medium; highest-value real mitigation)
- Server: extend the actuate SELECT to also pull `targetExecutablePath`/`targetExecutableHash`/`metadata.pid` and add `expectedTargetPath/Hash/Pid` to the `device_commands` payload (`actuateElevation.ts:190-195`).
- Agent: add those fields to `pamactuator.Request` (`actuator.go:45-62`), wire through `handlers_actuate.go:39-44/79-84`; in `actuator_windows.go` after `waitForConsent` (~:95) and BEFORE typing, resolve the intercept-time PID's image via `OpenProcess`+`QueryFullProcessImageNameW`, compare (case-insensitive) to `expectedTargetPath`; on mismatch/dead PID return `Result{Success:false, Reason:"target_mismatch"}`. Hash compare as the strongest variant when present.
- **Scope flag:** consent.exe→requesting-process correlation is genuinely hard; PID reuse is a residual race (mitigated by hash). Prefer (PID, start-time) tuple if intercept captures start-time. Factor the comparison into a pure `matchesExpectedTarget(...)` for cross-platform Go testing.

### #2a — Server-minted JIT credentials (large)
- Full: per-org credential vault / ephemeral local-admin minting at approval time; route stops accepting caller `username`/`password` (resolve server-side from approved row + org PAM config); rotate/revoke after completion.
- Interim: change the request schema to take a `credentialRef` resolved server-side (needs minimal org-PAM-config) — removes the "tech types a harvested password" vector without full rotation lifecycle.

### #4 — Approval route with separation of duties (large)
- New `POST .../elevation-requests/:reqId/approve`: gates `requireScope`, a NEW `ELEVATION_APPROVE` permission (add to `services/permissions.ts`), `requireMfa()` (decoupled per PR 5); enforce requester ≠ approver; transactional CAS `pending → approved`, set `approvedByUserId`/`approvedAt`, write `elevation_audit`.
- **Open product decisions:** how to define "requester" for `uac_intercept` rows (`subjectUserId=NULL`); whether `ELEVATION_APPROVE` is a distinct permission (today actuate reuses `DEVICES_EXECUTE`).

---

## Self-Review

- **Spec coverage:** #2 (Fix A in PR 6; #2a/#2b in Track 6), #3 (PR 5), #5 (PR 3), #6 (PR 2.1), #7 (PR 4), #8 (PR 2.2), #9 (PR 1.2), #10 (PR 1.1), #4 (Track 6). #1 excluded (other agent). Build-breaker flagged (main checkout, not this worktree). ✅
- **Placeholders:** Track-6 items are intentionally design-only (open product decisions noted) — not placeholder-failures in the actionable PRs.
- **Type consistency:** `isSecretYAMLKey` used in all 3 Go sites; `enable2fa()`/`ENABLE_2FA` back-compat noted; `allowPrivateNetwork`/`isAlwaysBlockedIp`/`isRfc1918OrUla` consistent across PR 3; `shouldSkipAgentAuth` exported + imported by its test.
