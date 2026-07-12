# Core Authentication Wave 6 Client-IP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive allowlist client IP from an explicit trusted boundary so client-supplied forwarding headers cannot bypass partner policy.

**Architecture:** Caddy strips forwarding input and overwrites one Breeze-only canonical header. API source modes accept either the direct socket or that canonical header from an exact trusted peer. Shipped Compose resolves/pins the `caddy` service hostname at API startup instead of committing an infrastructure IP. Non-empty allowlists fail closed when trusted resolution is unavailable.

**Tech Stack:** TypeScript, Hono, Caddy, Docker Compose, shell security guards, Vitest.

## Global Constraints

- Deploy/reload Caddy canonicalization before enabling API canonical-only enforcement.
- Do not commit real/internal IP addresses, hostnames, regions, or domain mappings; Compose service name `caddy` is the generic local boundary.
- Direct mode ignores every forwarding header.
- Canonical-proxy mode trusts only `X-Breeze-Client-IP` from startup-resolved exact proxy peers or explicit approved CIDRs.
- Raw Cloudflare headers are never authoritative in generic Caddy mode.
- Non-empty allowlist plus no trusted IP denies.
- Preserve explicit enforcement-mode-off break glass and document recovery.

---

### Task 1: Add explicit source-mode configuration

**Files:**
- Modify: `apps/api/src/config/validate.ts`
- Modify: `apps/api/src/config/validate.test.ts`
- Modify: `apps/api/src/services/clientIp.ts`
- Modify: `apps/api/src/services/clientIp.test.ts`

**Interfaces:**
- Adds `CLIENT_IP_TRUST_MODE=direct|canonical_proxy|cloudflare`.
- Adds startup-resolved `TRUSTED_PROXY_HOSTS` alongside explicit `TRUSTED_PROXY_CIDRS`.
- Produces structured `TrustedClientIpResult`.

- [ ] Write failing config tests for missing/unknown/contradictory production modes, direct with proxy config, canonical/cloudflare without trusted peers, wildcard/broad trust, and shipped valid defaults.
- [ ] Write failing resolver tests for direct spoofing, canonical trusted/untrusted peer, simultaneous CF/XFF spoofing, cloudflare-only raw CF, invalid/CSV canonical values, IPv4-mapped IPv6, and failed hostname resolution.
- [ ] Run RED.
- [ ] Implement source-mode parser and startup hostname resolution to exact IP set. Cache the resolved peer set for the process lifetime; readiness/config diagnostics identify resolution failure without exposing addresses publicly.
- [ ] Refactor resolver to return `{trusted:true,ip,source}` or bounded reason. Preserve a separate non-authoritative fingerprint helper for rate limiting where needed.
- [ ] Run GREEN and commit with `fix(edge): add explicit trusted client IP modes`.

### Task 2: Canonicalize the header at every Caddy API proxy

**Files:**
- Modify: `docker/Caddyfile.prod`
- Modify: `docker-compose.yml`
- Modify: `deploy/docker-compose.prod.yml`
- Modify: `docker-compose.override.yml.dev`
- Modify: `docker-compose.override.yml.ghcr`
- Modify: `docker-compose.override.yml.local-build`
- Modify: `.env.example`
- Modify: `deploy/.env.example`
- Modify: `scripts/guided-setup.sh`
- Modify: `scripts/check-guided-setup-compose-rewrites.sh`
- Modify: `scripts/security/check-relay-edge-hardening.sh`

**Interfaces:**
- Caddy overwrites `X-Breeze-Client-IP` from `{client_ip}` after removing inbound canonical/CF/XFF/X-Real-IP/True-Client-IP.
- Shipped API config uses `canonical_proxy` and `TRUSTED_PROXY_HOSTS=caddy` when routed through Caddy; direct development paths use `direct`.

- [ ] Extend the shell guard first so it fails against current Caddy/Compose. Assert every API reverse-proxy path invokes one canonicalization snippet and configs declare an explicit mode/trusted service.
- [ ] Run RED: `bash scripts/security/check-relay-edge-hardening.sh` and `bash scripts/check-guided-setup-compose-rewrites.sh`.
- [ ] Add a reusable Caddy snippet that deletes untrusted headers and sets the canonical header; import it for streaming, OAuth, `.well-known`, and general API proxy blocks. Restrict hosted upstream interpretation to the existing trusted cloudflared boundary.
- [ ] Update Compose/examples/guided setup with generic variables and no real IP values.
- [ ] Validate syntax using pinned Caddy image `caddy adapt` and every `docker compose ... config` variant.
- [ ] Run GREEN and commit with `fix(edge): canonicalize client IP at Caddy`.

### Task 3: Make partner allowlists fail closed

**Files:**
- Modify: `apps/api/src/services/ipAllowlist.ts`
- Modify: `apps/api/src/services/ipAllowlist.test.ts`
- Modify: `apps/api/src/middleware/ipAllowlistGuard.test.ts`
- Modify: `apps/api/src/routes/auth/login.test.ts`
- Modify: `apps/api/src/middleware/apiKeyAuth.test.ts`

**Interfaces:**
- Security decisions consume only `TrustedClientIpResult.trusted === true`.

- [ ] Write failing tests: non-empty list + missing/untrusted/misconfigured IP denies and audits; empty list/off skips; matching allows; nonmatching denies; platform-admin break glass remains explicit; login/MCP/API-key sentinels cannot use spoofed input.
- [ ] Run RED.
- [ ] Change `untrusted_ip` from skip to deny when policy is non-empty. Keep public response generic and audit reason/source without raw chains.
- [ ] Ensure rate-limit/audit consumers do not accidentally pass a non-authoritative fingerprint into allowlist evaluation.
- [ ] Run GREEN and commit with `fix(security): fail closed when allowlist IP is untrusted`.

### Task 4: Verify and document two-phase rollout

**Files:**
- Modify: `scripts/security/preflight.sh`
- Modify: `.github/workflows/ci.yml` only if a dedicated guard job is needed
- Modify: `CHANGELOG.md`
- Create: `docs/release-notes/trusted-client-ip-boundary.md`

- [ ] Add preflight/CI execution of the canonicalization guard and Caddy adaptation.
- [ ] Document rollout: deploy/reload Caddy while API still accepts old behavior; verify canonical header at API diagnostics; then deploy API/env canonical mode; verify allowlisted/non-allowlisted/break-glass paths.
- [ ] Document recovery through explicit `IP_ALLOWLIST_ENFORCEMENT_MODE=off`, with prominent audit/alerting and immediate configuration correction.
- [ ] Run full gates:

```bash
corepack pnpm --dir apps/api exec vitest run src/services/clientIp.test.ts src/services/ipAllowlist.test.ts src/middleware/ipAllowlistGuard.test.ts src/config/validate.test.ts src/middleware/apiKeyAuth.test.ts src/routes/auth/login.test.ts --maxWorkers=1 --fileParallelism=false
bash scripts/security/check-relay-edge-hardening.sh
bash scripts/check-guided-setup-compose-rewrites.sh
docker compose -f docker-compose.yml config >/dev/null
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev config >/dev/null
docker compose -f docker-compose.yml -f docker-compose.override.yml.ghcr config >/dev/null
docker compose -f docker-compose.yml -f docker-compose.override.yml.local-build config >/dev/null
corepack pnpm --filter @breeze/api build
```

- [ ] Independently review every Caddy proxy block, peer-resolution pinning, mode contradictions, fail-closed policy, break glass, and raw-header logging.
- [ ] Commit rollout/CI docs with `docs(edge): document trusted client IP rollout`.
