# Release notes template — security-hardening release

Copy this into the GitHub Release body when tagging the version that ships PR #568. Keep the **action-required block at the top** — the release-watch email truncates after the first ~30 lines for many email clients.

---

# v0.XX.0 — Security hardening (SR-001..SR-024)

## TL;DR — self-hosters, do this before `docker compose up`

> ⚠️ **This release has required pre-deploy steps.** Full runbook: [`UPGRADING.md`](https://github.com/LanternOps/breeze/blob/main/UPGRADING.md).
>
> 1. Run the FORCE-RLS ownership pre-check (one SQL query — see UPGRADING.md).
> 2. Add to `.env`: `APP_ENCRYPTION_KEY` (set to your **current** `JWT_SECRET`), `MFA_ENCRYPTION_KEY`, `ENROLLMENT_KEY_PEPPER`, `MFA_RECOVERY_CODE_PEPPER`.
> 3. If behind a reverse proxy with `TRUST_PROXY_HEADERS=true`: set `TRUSTED_PROXY_CIDRS` to your proxy IPs.
> 4. Deploy. Watch the API logs for warnings — each tells you which legacy path is still live.
>
> Designed to be backward-compatible: if you skip these, the API still starts and existing users keep working, but you'll see warnings and lose some defense-in-depth until the env vars are set.

## What's in this release

This is a cross-cutting security hardening pass landing fixes from a parallel review covering 24 areas: remote access, public installer/enrollment, system tools and command execution, AI/MCP execution and approvals, OAuth dynamic client registration, auth/session/MFA/SSO, multi-tenant isolation, backup/restore authorization, integrations and webhooks, frontend CSP, agent trust boundary, API keys and rate limiting, reports/exports/audit-log exposure, background jobs/queues, RLS migrations, admin lifecycle, log/SNMP ingestion, Tauri viewer/helper local-app security, installer privilege and ACLs, crypto and secret rotation, TURN/relay/WebRTC edge, production deploy defaults, and high-privilege third-party sync jobs.

The full review tracker is at `security_reports/security_review_tracker_2026-05-02.md`.

## Highlights

- **Encryption-at-rest hardening** — secrets, MFA seeds, SNMP creds, notification channels, and integration tokens move to dedicated encryption keys (`APP_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY`) instead of reusing auth secrets.
- **Webhook HMAC** — automation webhooks now support `x-breeze-signature` + `x-breeze-timestamp`. Legacy header-secret auth still works this release; flips to HMAC-only in the next release.
- **OAuth DCR cleanup** excludes clients with active grants/auth codes/refresh tokens — safe for active MCP integrations.
- **FORCE RLS** on tenant-scoped tables — RLS now applies even to the table owner.
- **Agent token hash** auth tightened with a graceful re-enrollment signal (`code: 're_enrollment_required'`) for devices that predate the hash migration.
- **Trusted proxy CIDRs** — `TRUSTED_PROXY_CIDRS` is now strictly validated; missing config defaults to loopback in production with a warning instead of trusting all upstreams.
- **Reports permission** — new `reports:export` permission, granted automatically to any role that already had `reports:read` or `reports:write`.

## Backward-compatibility windows (will tighten in the **next** release)

Several flags default to legacy behavior for one release so existing deployments aren't stranded. Each emits a warning when the legacy path runs — fix it before the next release:

- `SSO_EXCHANGE_RETURN_REFRESH_TOKEN=true` (default) — flips to `false` next release. Migrate SSO clients to read the `breeze_refresh_token` HttpOnly cookie.
- `AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET=true` (default) — flips to `false` next release. Migrate webhook senders to HMAC.
- `ENROLLMENT_SECRET_ENFORCEMENT_MODE=warn` — opt-in, accepted only in this release. Set `AGENT_ENROLLMENT_SECRET` (or per-key secrets) before upgrading further.
- Legacy enrollment-key pepper fallback — removed once you re-hash existing keys.
- Legacy `enc:v1:` decrypt fallback — removed once `pnpm tsx scripts/re-encrypt-secrets.ts` has run.

## Upgrade path

See [`UPGRADING.md`](https://github.com/LanternOps/breeze/blob/main/UPGRADING.md) for the full pre-deploy / post-deploy runbook. Watch the API logs after deploy for the warnings listed there — each tells you exactly which legacy path is still live and what to do about it.

## Full changelog

<!-- Generate with: gh api repos/LanternOps/breeze/compare/v0.XX.0...v0.YY.0 --jq '.commits[] | "- \(.sha[0:7]) \(.commit.message | split("\n")[0])"' -->
