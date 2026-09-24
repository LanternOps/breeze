---
tracking_issue: LanternOps/breeze#6768
---

# System page W01 (API): connection status report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `GET /api/v1/admin/system/connections`, a platform-admin-only, read-only report of which integrations this API container has configured, backed by a curated env registry whose secrecy and coverage are enforced by six invariant tests; delete the old `GET /system/config-status`.

**Architecture:** A new pure module `apps/api/src/system/connections/` holds the registry (`CONNECTION_REGISTRY`, default-deny secrecy), the internal-var list (`INTERNAL_ENV_VARS`), status helpers, resolver-mirroring status functions for the core entries, and `buildConnectionsReport(env)`. A thin Hono router mounted with `adminRoutes.route('/system', …)` inherits `platformAdminMiddleware` and returns `{ data: buildConnectionsReport(process.env) }`. A source-scanning ratchet test keeps the registry and internal list in lockstep with every env name the API reads.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Hono, Vitest. No DB, no new dependencies.

**Spec:** `docs/superpowers/specs/platform-ci/2026-09-23-system-connections-page-design.md` (approved; Fable quorum amendments adopted, the spec is authoritative). Read it, including the Quorum record, before Task 1.

## Global Constraints

- **Worktree:** `/Users/toddhebebrand/breeze-wt-system-page` (branch `spec/system-connections-page`). All paths below are relative to it. Run vitest from `apps/api`.
- **W01 is API only.** No file under `apps/web`, `apps/portal` or `apps/docs` changes.
- **Read-only (D1).** The router exposes GET only; POST, PUT, PATCH and DELETE return 404.
- **Secrets are never shown (D2).** A secret var renders only `set: true|false`. No masking, no last-4.
- **Default-deny secrecy (D8).** A var is secret unless its registry line says `secret: false`.
- **Config only (D4).** No live probes, no network, no DB reads in the report or the route.
- **API container only (D5).** `scope: 'api'` in every report.
- **Platform admins only (D6).** Mount only with `adminRoutes.route('/system', …)` in `apps/api/src/routes/admin/index.ts` (behind `adminRoutes.use('*', platformAdminMiddleware)` at line 17). **Never** add `api.route('/admin/...')` in `apps/api/src/index.ts`.
- **One env-status truth (D9).** `GET /system/config-status` (`apps/api/src/routes/system.ts:33-80`) and its tests are deleted in Task 1.
- **Status mirrors the resolvers (D10).** Database, Redis and email use custom `status()` functions that follow `resolveRequestDatabaseConfig`, `resolveRedisUrl` and `resolveEmailProviderConfig`.
- **`*_FILE` (D11).** A var is `set` if `X` or `X_FILE` is set. Nothing in this feature opens a file.
- **Reasons name vars, never values** (invariant 4).
- **Response shape:** `{ data: ConnectionsReport }` (same `data` wrapper as #6744's deprecations route), header `Cache-Control: no-store`.
- **ConnectionGroup ids (shared with the W02 web plan), exactly:** `core`, `email`, `storage-backups`, `ai`, `billing`, `microsoft-365`, `identity-sso`, `remote-access`, `agent-releases`, `observability`, `security-abuse`, `integrations`.
- **Red first.** Every task writes its test, runs it, and sees it fail for the stated reason before writing the implementation.
- **Typecheck:** `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit=$?"`. Read the exit code directly. **Never pipe tsc into `tail`/`head`** — the pipe masks a heap OOM as a false green.
- **Commits:** one per task, message ends with a blank line then `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Spec ambiguities resolved in this plan (read before implementing)

1. **Ratchet scan shapes are broader than the spec's list.** The spec's `process.env` + named-helper regex (plus `ENV_SCHEMA_KEYS` and `enableEnvVar`) finds 454 names; it misses 142 real names the API reads, for example every M365 executor var (`required(source, 'M365_GRAPH_READ_EXECUTOR_URL')`, `services/m365ControlPlane/runtimeConfig.ts:43-47`), retention knobs read as `parsePositiveIntEnv(LOG_PREFIX, 'AGENT_LOG_RETENTION_BATCH_SIZE', …)` (`jobs/agentLogRetention.ts:33`), `source.IP_CLASSIFY_PROVIDER` (`config/env.ts:369`), `resolveMsKnob('BACKUP_BASE_LEASE_MS', …)` (`services/backupGcKnobs.ts:52`), `parseTransportTimeoutMs('SMTP_TIMEOUT_MS', …)` (`services/email.ts:804`) and `const MAX_ATTEMPTS_ENV = 'SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS'` (`services/softwareInstallRemediationKnobs.ts:22`). Task 5 uses the five shapes in the table below; they are a superset of the spec's shapes, so the spec's intent ("every read shape the codebase uses") holds.
2. **The ratchet skips `src/system/connections/` itself.** The status functions name env vars on purpose (`hasValue(env, 'DATABASE_URL')`), which the `envObjectArg` shape would otherwise count as reads and keep stale names alive.
3. **Six scan tokens are not env names** (`BUCKET`, `ENDPOINT`, `REGION` from `envFor(region, 'BUCKET')` in `services/artifacts/blobStorage.ts:206-217`; `KEY`, `X`, `SOME_TTL_MINUTES` from docblocks). They live in a `SCAN_NOISE` map inside the ratchet test with a reason each, and the test fails if one stops appearing, so the map cannot rot.
4. **Email "RESEND_API_KEY only ⇒ enabled" (invariant 5 example) conflicts with the resolver.** `resolveEmailProviderConfig` (`services/email.ts:834-876`) requires `EMAIL_FROM` for Resend and throws without it. D10 (status mirrors the resolver) wins. The truthfulness test uses the compose shape, where `EMAIL_FROM` always has a default (`docker-compose.yml:187-189`: `EMAIL_PROVIDER=auto`, `EMAIL_FROM=noreply@breeze.local`), and asserts `enabled` with provider `resend`. A bare `RESEND_API_KEY` with no `EMAIL_FROM` is `misconfigured` naming `EMAIL_FROM`.
5. **"(provider resend)" is carried in `reason`.** The spec's `status()` returns `{ status, reason? }` only. Enabled core entries return an informational reason (`'Provider: resend (auto-detected)'`, `'Using REDIS_HOST and REDIS_PORT'`, `'Request pool derived from DATABASE_URL for the breeze_app role'`). No new field is added. Reasons are constant strings plus var names and provider enum names; they never interpolate env values.
6. **The value-shape guard also refuses URL query strings and PEM/`private_key` material at runtime,** not only URL userinfo. Keys ride in query strings (the spec's own `CSP_REPORT_URI` example), and public origins never need one. Strictly safer than the spec; the refused value still renders as `set`.
7. **Entry count is 56, not ~30–40.** The inventory has 594 real env names; splitting per integration keeps every status honest (a single "warranty" entry would need bespoke any-of logic). The W02 page groups them into the 12 sections, so the count does not reach the UI as clutter.
8. **Database status calls the real resolver.** `resolveRequestDatabaseConfig` (`apps/api/src/db/requestDatabaseConfig.ts:113-140`) is pure over the env object it is given, so `databaseStatus` calls it and maps `source` (`explicit` / `derived` / `development-fallback`) or a throw to a status. It never forwards the resolver's error text. (The spec's `config/validate.ts:1012-1020` citation is the production-boot refinement; the derivation itself lives in `requestDatabaseConfig.ts`.)
9. **Redis with neither `REDIS_URL` nor `REDIS_HOST` is `required_missing`**, even though `resolveRedisUrl` falls back to `localhost:6379`. A core entry that works only by accident of a localhost default is exactly what the page should surface; the reason says so.
10. **Names that disappear with `/system/config-status`.** `BREEZE_DOMAIN`, `OPENAI_API_KEY`, `RESEND_FROM` and `STORAGE_PROVIDER` are read only by the deleted handler (`routes/system.ts:33-80`). After Task 1 no code reads them, so they are in neither list (the ratchet's stale check would reject them).
11. **Known ratchet blind spots, accepted:** allowlist arrays that are forwarded rather than read as config (`SDK_CHILD_ENV_ALLOWLIST` in `services/streamingSessionManager.ts:132-158`: `PATH`, `HOME`, `NODE_EXTRA_CA_CERTS`, …); the inert legacy third argument of `cronFromEnv` (`*_INTERVAL_MS`, warn-only, `jobs/scheduleRegistry.ts:248-261`); templated names (`ARTIFACT_S3_${suffix}_${REGION}`), which are covered anyway because every expansion is an `ENV_SCHEMA_KEYS` key.
12. **Merge order with #6744.** #6744 also appends a line to `routes/admin/index.ts`. Whichever lands second rebases; the conflict is two adjacent `adminRoutes.route(...)` lines, keep both.

## Env inventory (built 2026-09-23 on this branch, after deleting `/system/config-status`)

| Count | Value |
|---|---|
| Real env names found by the ratchet scan (incl. 155 `ENV_SCHEMA_KEYS`, 1 builtin `enableEnvVar`) | 594 |
| Registry entries | 56 |
| Registry vars | 256 |
| … of which `secret: false` | 147 |
| … of which secret (default) | 109 |
| `SECRET_NAME_EXCEPTIONS` | 24 |
| `INTERNAL_ENV_VARS` | 338 |
| `SCAN_NOISE` tokens (not env names) | 6 |

256 + 338 = 594: every name is classified exactly once.

### Ratchet scan shapes (Task 5)

| Shape | Catches | Example (file:line) |
|---|---|---|
| `processEnv` | `process.env.X`, `process.env['X']`, `process.env["X"]` | `services/redis.ts:100` |
| `envHelper` | literal first arg — or second, after a prefix arg — of any call whose name contains `Env`/`env`/`Knob`/`TimeoutMs` (covers the spec's `envFlag`, `envInt`, `envStr`, `envFloat`, `getEnvString`, `positiveIntEnv`, `cronFromEnv`, the local copies in `routes/mcpServer.ts:74-81` and `db/wedgedBackends.ts:96-100`, plus `envString`, `envHours`, `parsePositiveIntEnv`, `resolveMsKnob`, `parseTransportTimeoutMs`, `platformEnv`, `positiveIntFromEnv`, `readPositiveIntEnv`) | `jobs/agentLogRetention.ts:33` |
| `envAlias` | `env.X`, `source.X`, `source?.X`, `env['X']` (env objects passed around) | `config/env.ts:369` |
| `envObjectArg` | `fn(process.env \| env \| source, 'X')` | `services/m365ControlPlane/commsRuntimeConfig.ts:70`, `config/env.ts:53-57` |
| `envNameConst` | `const SOMETHING_ENV = 'X'` | `db/requestDatabaseRoleSafety.ts:26` |

Plus every key of `ENV_SCHEMA_KEYS` (`config/validate.ts:2338`) and every `enableEnvVar` of `BUILTINS` (`extensions/builtinRegistry.ts:238-251`), enumerated from those exports.

### Every `secret: false` var, justified

A reviewer rejects the W01 PR if any line here is wrong. "Exception" = the name matches the secret-name pattern and is listed in `SECRET_NAME_EXCEPTIONS` (Task 4) with its reason. URL-valued vars are additionally protected at runtime: a value with URL userinfo or a query string is refused and renders as `set` only.

| Var | Entry | Why the value is safe to show | Exception |
|---|---|---|---|
| `REDIS_HOST` | redis | hostname or IP, no credential | |
| `REDIS_PORT` | redis | port number | |
| `BREEZE_ALLOW_UNAUTH_REDIS` | redis | boolean flag | |
| `PUBLIC_APP_URL` | public-urls | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `PUBLIC_API_URL` | public-urls | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `DASHBOARD_URL` | public-urls | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `PUBLIC_URL` | public-urls | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `PUBLIC_PORTAL_URL` | public-urls | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `PUBLIC_WEB_URL` | public-urls | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `API_URL` | public-urls | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `BREEZE_SERVER` | public-urls | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | |
| `PORTAL_BASE_PATH` | public-urls | filesystem or URL path, no credential | |
| `PUBLIC_ACTIVATION_BASE_URL` | public-urls | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `CORS_ALLOWED_ORIGINS` | public-urls | public origin list | |
| `CORS_INCLUDE_DEFAULT_ORIGINS` | public-urls | boolean flag | |
| `WEBAUTHN_ORIGIN` | public-urls | public origin list | |
| `WEBAUTHN_RP_ID` | public-urls | display label / image or environment name | |
| `WEBAUTHN_RP_NAME` | public-urls | display label / image or environment name | |
| `EMAIL_PROVIDER` | email | enum selector | |
| `EMAIL_FROM` | email | sender/recipient address shown in outbound mail or SMS | |
| `SMTP_HOST` | email | hostname or IP, no credential | |
| `SMTP_PORT` | email | port number | |
| `SMTP_SECURE` | email | boolean flag | |
| `SMTP_FROM` | email | sender/recipient address shown in outbound mail or SMS | |
| `MAILGUN_DOMAIN` | email | domain name(s) | |
| `MAILGUN_FROM` | email | sender/recipient address shown in outbound mail or SMS | |
| `MAILGUN_BASE_URL` | email | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `EMAIL_SUPPORT_ADDRESS` | email | sender/recipient address shown in outbound mail or SMS | |
| `EMAIL_DOMAINS_PROVIDER` | partner-sending-domains | enum selector | |
| `EMAIL_DOMAINS_REGION` | partner-sending-domains | cloud region name | |
| `EMAIL_DOMAINS_STATIC_ALLOWED` | partner-sending-domains | domain name(s) | |
| `TICKETS_INBOUND_DOMAIN` | inbound-ticket-email | domain name(s) | |
| `S3_BUCKET` | object-storage | bucket name | |
| `S3_ENDPOINT` | object-storage | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `S3_REGION` | object-storage | cloud region name | |
| `ARTIFACT_BLOB_BACKEND` | object-storage | enum selector | |
| `ARTIFACT_S3_BUCKET_US` | object-storage | bucket name | |
| `ARTIFACT_S3_BUCKET_EU` | object-storage | bucket name | |
| `ARTIFACT_S3_ENDPOINT_US` | object-storage | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `ARTIFACT_S3_ENDPOINT_EU` | object-storage | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `ARTIFACT_S3_REGION_US` | object-storage | cloud region name | |
| `ARTIFACT_S3_REGION_EU` | object-storage | cloud region name | |
| `ARTIFACT_S3_SSE` | object-storage | enum selector | |
| `AGENT_BACKUP_SERVER_URL` | backup-failover-url | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `C2C_M365_CLIENT_ID` | c2c-m365-backup | public app/client identifier (appears in consent URLs or app bundles) | |
| `ANTHROPIC_BASE_URL` | anthropic | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `ANTHROPIC_MODEL` | anthropic | model id | |
| `MCP_LLM_BASE_URL` | openai-compatible-llm | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `MCP_LLM_PROVIDER` | openai-compatible-llm | enum selector | |
| `MCP_LLM_MODEL` | openai-compatible-llm | model id | |
| `MCP_LLM_PRICE_INPUT_PER_M_USD` | openai-compatible-llm | numeric tuning value | |
| `MCP_LLM_PRICE_OUTPUT_PER_M_USD` | openai-compatible-llm | numeric tuning value | |
| `LLM_PROVIDER_CATALOG_ENABLED` | llm-provider-catalog | boolean flag | |
| `BREEZE_AI_AGENTS_ENABLED` | ai-agents | boolean flag | |
| `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` | ai-agents | boolean flag | |
| `BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED` | ai-agents | boolean flag | |
| `BREEZE_AI_SCRIPT_AUTHORING_ENABLED` | ai-agents | boolean flag | |
| `BREEZE_AI_SCRIPT_REVIEWER_MODEL` | ai-agents | model id | |
| `AI_OPERATOR_TASKS_ENABLED` | ai-agents | boolean flag | |
| `AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED` | ai-agents | boolean flag | |
| `BREEZE_AI_WORKSPACE_ENABLED` | ai-workspace-sandbox | boolean flag | |
| `AI_WORKSPACE_BACKEND` | ai-workspace-sandbox | enum selector | |
| `VERCEL_SANDBOX_IMAGE` | ai-workspace-sandbox | display label / image or environment name | |
| `VERCEL_SANDBOX_REGION_US` | ai-workspace-sandbox | cloud region name | |
| `VERCEL_SANDBOX_REGION_EU` | ai-workspace-sandbox | cloud region name | |
| `BREEZE_WORKSPACE_ENABLED` | workspace-extension | boolean flag | |
| `TOOL_SOURCES_ENABLED` | tool-sources | boolean flag | |
| `TOOL_SOURCES_ALLOW_PRIVATE_EGRESS` | tool-sources | boolean flag | yes |
| `BREEZE_BILLING_URL` | breeze-billing | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `BILLING_URL` | breeze-billing | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `BILLING_SERVICE_URL` | ai-cost-billing | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `STRIPE_SESSION_REVOCATION_MODE` | stripe | enum selector | |
| `STRIPE_ACCOUNT_CACHE_REFRESH_ENABLED` | stripe | boolean flag | |
| `QBO_CLIENT_ID` | quickbooks | public app/client identifier (appears in consent URLs or app bundles) | |
| `QBO_REDIRECT_URI` | quickbooks | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `QBO_ENVIRONMENT` | quickbooks | enum selector | |
| `M365_ENABLED` | m365-identity-tools | boolean flag | |
| `M365_TENANT_SYNC_ENABLED` | m365-tenant-sync | boolean flag | |
| `M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED` | m365-graph-read | boolean flag | |
| `M365_GRAPH_READ_TOOLS_ENABLED` | m365-graph-read | boolean flag | |
| `M365_CUSTOMER_GRAPH_READ_CLIENT_ID` | m365-graph-read | public app/client identifier (appears in consent URLs or app bundles) | |
| `M365_GRAPH_READ_EXECUTOR_AUDIENCE` | m365-graph-read | fixed audience constant checked by the resolver | |
| `M365_CUSTOMER_GRAPH_READ_ONBOARDING_ORG_IDS` | m365-graph-read | allowlist of Breeze org/user UUIDs | |
| `M365_GRAPH_READ_TOOLS_ORG_IDS` | m365-graph-read | allowlist of Breeze org/user UUIDs | |
| `M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED` | m365-graph-actions | boolean flag | |
| `M365_GRAPH_ACTIONS_TOOLS_ENABLED` | m365-graph-actions | boolean flag | |
| `M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID` | m365-graph-actions | public app/client identifier (appears in consent URLs or app bundles) | |
| `M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE` | m365-graph-actions | fixed audience constant checked by the resolver | |
| `M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ORG_IDS` | m365-graph-actions | allowlist of Breeze org/user UUIDs | |
| `M365_GRAPH_ACTIONS_TOOLS_ORG_IDS` | m365-graph-actions | allowlist of Breeze org/user UUIDs | |
| `M365_COMMS_ONBOARDING_ENABLED` | m365-comms | boolean flag | |
| `M365_COMMS_TOOLS_ENABLED` | m365-comms | boolean flag | |
| `M365_COMMS_CLIENT_ID` | m365-comms | public app/client identifier (appears in consent URLs or app bundles) | |
| `M365_COMMS_EXECUTOR_AUDIENCE` | m365-comms | fixed audience constant checked by the resolver | |
| `M365_COMMS_ONBOARDING_USER_IDS` | m365-comms | allowlist of Breeze org/user UUIDs | |
| `M365_COMMS_TOOLS_USER_IDS` | m365-comms | allowlist of Breeze org/user UUIDs | |
| `TICKET_MAILBOX_M365_CLIENT_ID` | ticket-mailbox-m365 | public app/client identifier (appears in consent URLs or app bundles) | |
| `ENROLLMENT_SECRET_ENFORCEMENT_MODE` | agent-enrollment-secret | enum selector | yes |
| `CF_ACCESS_TRUST_ENABLED` | cloudflare-access | boolean flag | |
| `CF_ACCESS_TEAM_DOMAIN` | cloudflare-access | domain name(s) | |
| `CF_ACCESS_TRUSTS_MFA` | cloudflare-access | boolean flag | |
| `CLIENT_AI_ENTRA_CLIENT_ID` | client-ai-entra | public app/client identifier (appears in consent URLs or app bundles) | |
| `TWILIO_PHONE_NUMBER` | twilio | sender/recipient address shown in outbound mail or SMS | |
| `APPLE_APP_ATTEST_APP_ID` | mobile-attestation | public app/client identifier (appears in consent URLs or app bundles) | |
| `APPLE_APP_ATTEST_ENVIRONMENT` | mobile-attestation | enum selector | |
| `BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED` | mobile-attestation | boolean flag | |
| `TURN_HOST` | turn | hostname or IP, no credential | |
| `TURN_PORT` | turn | port number | |
| `TURN_TLS_HOST` | turn | hostname or IP, no credential | |
| `TURN_TLS_PORT` | turn | port number | |
| `TURN_TLS_DIR` | turn | filesystem or URL path, no credential | |
| `BINARY_SOURCE` | agent-binaries | enum selector | |
| `BINARY_GITHUB_REPOSITORY` | agent-binaries | public GitHub owner/repo | |
| `GITHUB_REPO` | agent-binaries | public GitHub owner/repo | |
| `BINARY_VERSION` | agent-binaries | version string / promote flag | |
| `BREEZE_VERSION` | agent-binaries | version string / promote flag | |
| `BINARY_EDITION` | agent-binaries | enum selector | |
| `AGENT_AUTO_PROMOTE` | agent-binaries | version string / promote flag | |
| `RELEASE_ARTIFACT_MANIFEST_VERIFICATION` | update-manifest-signing | enum selector | |
| `SENTRY_ENVIRONMENT` | sentry | enum selector | |
| `SENTRY_TRACES_SAMPLE_RATE` | sentry | numeric tuning value | |
| `SENTRY_PROFILES_SAMPLE_RATE` | sentry | numeric tuning value | |
| `METRICS_SCRAPE_IP_ALLOWLIST` | metrics-scrape | CIDR/IP allowlist | |
| `OPS_ALERT_EMAIL` | ops-alerts | sender/recipient address shown in outbound mail or SMS | |
| `OPS_ALERT_LABEL` | ops-alerts | display label / image or environment name | |
| `FORCE_HTTPS` | transport-security | boolean flag | |
| `TRUST_PROXY_HEADERS` | transport-security | boolean flag | |
| `TRUSTED_PROXY_CIDRS` | transport-security | CIDR/IP allowlist | |
| `TRUST_CF_CONNECTING_IP` | transport-security | boolean flag | |
| `AGENT_MTLS_BINDING_MODE` | cloudflare-mtls | enum selector | |
| `ABUSE_SIGNALS_ENABLED` | abuse-signals | boolean flag | |
| `IP_CLASSIFY_PROVIDER` | ip-classify | enum selector | |
| `DELEGANT_BASE_URL` | delegant | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `MCP_OAUTH_ENABLED` | mcp-oauth | boolean flag | |
| `OAUTH_ISSUER` | mcp-oauth | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | |
| `OAUTH_RESOURCE_URL` | mcp-oauth | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `OAUTH_CONSENT_URL_BASE` | mcp-oauth | URL; a value with userinfo or a query string is refused at runtime (renders `set` only) | yes |
| `OAUTH_DCR_ENABLED` | mcp-oauth | boolean flag | |
| `OAUTH_DCR_ALLOW_ANONYMOUS` | mcp-oauth | boolean flag | |
| `OAUTH_DCR_REQUIRE_IAT` | mcp-oauth | boolean flag | |
| `GOOGLE_WORKSPACE_ENABLED` | google-workspace-tools | boolean flag | |
| `APNS_TEAM_ID` | apns | public app/client identifier (appears in consent URLs or app bundles) | |
| `APNS_BUNDLE_ID` | apns | public app/client identifier (appears in consent URLs or app bundles) | |
| `APNS_ENVIRONMENT` | apns | enum selector | |
| `DELL_CLIENT_ID` | warranty-dell | public app/client identifier (appears in consent URLs or app bundles) | |
| `LENOVO_WARRANTY_ENABLED` | warranty-lenovo | boolean flag | |
| `HP_WARRANTY_ENABLED` | warranty-hp | boolean flag | |

Everything not in this table is secret, including values that are *probably* harmless (key ids such as `APP_ENCRYPTION_KEY_ID`, `JWT_ACTIVE_KID`, `CF_ACCESS_AUD`, `VERCEL_TEAM_ID`, M365 `*_CREDENTIAL_VERSION` and `*_VAULT_REF`, executor URLs). When unsure, secret.

## File structure

| File | Responsibility |
|---|---|
| `apps/api/src/routes/system.ts` (modify) | Delete `/config-status` + its now-unused imports |
| `apps/api/src/routes/system.test.ts` (modify) | Replace the `/config-status` cases with one 404 test |
| `apps/api/src/system/connections/types.ts` (create) | `ConnectionGroup`, `ConnectionStatus`, `ConnectionVar`, `ConnectionEntry`, `EnvSnapshot`, report types |
| `apps/api/src/system/connections/statusHelpers.ts` (create) | `hasValue`, `isSet` (D11), `isFlagOn`, `listNames`, `defaultStatus`, `flagStatus`, `anyOfStatus`, `defineEntry` |
| `apps/api/src/system/connections/customStatus.ts` (create) | Resolver-mirroring status: `databaseStatus`, `redisStatus`, `emailStatus`, plus `agentBinariesStatus`, `workspaceExtensionStatus`, `transportSecurityStatus` |
| `apps/api/src/system/connections/registry.ts` (create) | `CONNECTION_REGISTRY`, `SECRET_NAME_PATTERN`, `SECRET_NAME_EXCEPTIONS` |
| `apps/api/src/system/connections/internalEnvVars.ts` (create) | `INTERNAL_ENV_VARS` (name → one-phrase reason) |
| `apps/api/src/system/connections/report.ts` (create) | `buildConnectionsReport(env)`, `displayableValue(raw)` |
| `apps/api/src/routes/admin/systemConnections.ts` (create) | `GET /connections` router |
| `apps/api/src/routes/admin/index.ts` (modify) | `adminRoutes.route('/system', systemConnectionsAdminRoutes)` |
| Tests (create) | `statusHelpers.test.ts`, `customStatus.test.ts`, `registry.test.ts`, `envInventory.test.ts`, `report.test.ts` (same dir), `routes/admin/systemConnections.test.ts` |

Invariant → test map: 1 → `envInventory.test.ts`; 2 → `report.test.ts` + `systemConnections.test.ts`; 3 → `registry.test.ts`; 4 → `report.test.ts` (reasons are inside the serialized report the canary scans); 5 → `customStatus.test.ts`; 6 → `systemConnections.test.ts`.

---

### Task 1: Delete `GET /system/config-status` (D9)

**Files:**
- Modify: `apps/api/src/routes/system.ts:1-16` (imports + `requireSystemConfigRead`), `apps/api/src/routes/system.ts:33-80` (handler)
- Test: `apps/api/src/routes/system.test.ts:116-260` (the `GET /config-status` describe), `apps/api/src/routes/system.test.ts:330-364` (three config-status cases inside `multi-tenant isolation`)

**Interfaces:**
- Consumes: nothing.
- Produces: `systemRoutes` keeps `GET /version` and `POST /setup-complete` only. Zero consumers of `/config-status` exist outside `system.test.ts` (verified: `grep -rn "config-status" apps packages e2e-tests` finds only these two files).

- [ ] **Step 1: Replace the config-status tests with one "gone" test**

In `apps/api/src/routes/system.test.ts`, delete lines 330-364 first (the three `it(...)` blocks in `describe('multi-tenant isolation')` whose titles mention `config-status`, plus the blank line after them — keep `it('setup-complete only affects the authenticated user, not other tenants', …)`). Then replace lines 116-260 (from `// ────────────────────── GET /config-status ──────────────────────` through the closing `});` of that describe) with:

```ts
  // ────────────────────── GET /config-status (removed, spec D9) ──────────────────────
  describe('GET /config-status', () => {
    it('is gone: env status lives only at GET /admin/system/connections (platform admins)', async () => {
      const res = await app.request('/system/config-status');
      expect(res.status).toBe(404);
    });
  });
```

(Delete the later block first so the earlier line numbers stay valid.)

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/routes/system.test.ts`
Expected: FAIL — `is gone: …` with `AssertionError: expected 200 to be 404`; the other 8 tests pass.

- [ ] **Step 3: Delete the handler and its imports**

In `apps/api/src/routes/system.ts`:
- delete lines 33-80 (the `// GET /system/config-status …` comment through the handler's closing `});` and the blank line after it);
- change line 5 to `import { authMiddleware } from '../middleware/auth';`;
- delete line 7 (`import { PERMISSIONS } from '../services/permissions';`) and line 8 (`import { envFlag } from '../utils/envFlag';`);
- delete lines 13-16 (`const requireSystemConfigRead = requirePermission(…);`).

The file header becomes:

```ts
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { authMiddleware } from '../middleware/auth';
import { API_VERSION } from '../version';
import { semverCompare } from '@breeze/shared';
import { getLatestVersion } from '../services/latestVersion';

export const systemRoutes = new Hono();

systemRoutes.use('*', authMiddleware);
```

followed unchanged by `systemRoutes.get('/version', …)` and `systemRoutes.post('/setup-complete', …)`.

- [ ] **Step 4: Run the tests and confirm green**

Run: `cd apps/api && npx vitest run src/routes/system.test.ts`
Expected: PASS, 9 tests.

Run: `grep -rn "config-status" apps packages e2e-tests --include='*.ts' --include='*.tsx' --include='*.astro'`
Expected: only the new 404 test in `apps/api/src/routes/system.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/system.ts apps/api/src/routes/system.test.ts
git commit -m "refactor(api): remove GET /system/config-status (spec D9)

Zero consumers; partner-scope ORGS_READ gate was weaker than the new
platform-admin System page. Env status moves to
GET /admin/system/connections.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Types and status helpers

**Files:**
- Create: `apps/api/src/system/connections/types.ts`
- Create: `apps/api/src/system/connections/statusHelpers.ts`
- Test: `apps/api/src/system/connections/statusHelpers.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 3–7):
  - `types.ts`: `CONNECTION_GROUPS` (readonly tuple of the 12 group ids), `type ConnectionGroup`, `CONNECTION_STATUSES`, `type ConnectionStatus = 'enabled' | 'disabled' | 'misconfigured' | 'required_missing'`, `type EnvSnapshot = Readonly<Record<string, string | undefined>>`, `type ConnectionVar = { name: string; secret?: boolean; required?: boolean }`, `type StatusResult = { status: ConnectionStatus; reason?: string }`, `type ConnectionEntry = { id; group; label; docsUrl?; core?; vars: readonly ConnectionVar[]; status(env: EnvSnapshot): StatusResult }`, `type ConnectionsReportVar = { name; secret: boolean; set: boolean; value?: string }`, `type ConnectionsReportEntry`, `type ConnectionsReport = { version; deployMode: 'hosted' | 'self_host'; scope: 'api'; summary: Record<ConnectionStatus, number>; groups: Array<{ group: ConnectionGroup; entries: ConnectionsReportEntry[] }> }`.
  - `statusHelpers.ts`: `hasValue(env, name): boolean`, `isSet(env, name): boolean` (D11), `isFlagOn(env, name): boolean`, `listNames(names): string`, `defaultStatus(entry, env): StatusResult`, `flagStatus(flags, requiredWhenOn, env): StatusResult`, `anyOfStatus(names, env): StatusResult`, `type StatusSpec`, `type EntrySpec`, `defineEntry(spec: EntrySpec): ConnectionEntry`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/system/connections/statusHelpers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  anyOfStatus,
  defaultStatus,
  defineEntry,
  flagStatus,
  hasValue,
  isFlagOn,
  isSet,
  listNames,
} from './statusHelpers';

describe('hasValue / isSet (D11)', () => {
  it('treats blank and whitespace-only values as unset', () => {
    expect(hasValue({ A: '' }, 'A')).toBe(false);
    expect(hasValue({ A: '   ' }, 'A')).toBe(false);
    expect(hasValue({}, 'A')).toBe(false);
    expect(hasValue({ A: 'x' }, 'A')).toBe(true);
  });

  it('counts NAME_FILE as set without opening the file', () => {
    // The path does not exist: if isSet tried to read it, it would throw.
    expect(isSet({ REDIS_PASSWORD_FILE: '/nonexistent/redis_password' }, 'REDIS_PASSWORD')).toBe(true);
    expect(isSet({ REDIS_PASSWORD: 'x' }, 'REDIS_PASSWORD')).toBe(true);
    expect(isSet({ REDIS_PASSWORD_FILE: '  ' }, 'REDIS_PASSWORD')).toBe(false);
  });
});

describe('isFlagOn', () => {
  it.each(['1', 'true', 'TRUE', ' yes ', 'on'])('%j is on', (raw) => {
    expect(isFlagOn({ F: raw }, 'F')).toBe(true);
  });
  it.each(['0', 'false', 'no', 'off', '', 'enabled'])('%j is off', (raw) => {
    expect(isFlagOn({ F: raw }, 'F')).toBe(false);
  });
});

describe('listNames', () => {
  it('joins names in English', () => {
    expect(listNames(['A'])).toBe('A');
    expect(listNames(['A', 'B'])).toBe('A and B');
    expect(listNames(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe('defaultStatus', () => {
  const entry = {
    vars: [
      { name: 'SMTP_HOST', required: true },
      { name: 'SMTP_PASS', required: true },
      { name: 'SMTP_PORT', secret: false },
    ],
  };

  it('enabled when every required var is set; optional vars do not matter', () => {
    expect(defaultStatus(entry, { SMTP_HOST: 'h', SMTP_PASS: 'p' })).toEqual({ status: 'enabled' });
  });

  it('disabled when no required var is set, even if an optional one is', () => {
    expect(defaultStatus(entry, { SMTP_PORT: '587' })).toEqual({ status: 'disabled' });
  });

  it('required_missing (not disabled) for a core entry', () => {
    expect(defaultStatus({ ...entry, core: true }, {})).toEqual({
      status: 'required_missing',
      reason: 'SMTP_HOST and SMTP_PASS are not set',
    });
  });

  it('misconfigured names what is set and what is missing', () => {
    expect(defaultStatus(entry, { SMTP_HOST: 'h' })).toEqual({
      status: 'misconfigured',
      reason: 'SMTP_HOST is set but SMTP_PASS is missing',
    });
  });
});

describe('flagStatus / anyOfStatus', () => {
  it('disabled while every flag is off', () => {
    expect(flagStatus(['F1', 'F2'], ['NEED'], { F1: 'false' })).toEqual({ status: 'disabled' });
  });
  it('enabled when a flag is on and requirements are met', () => {
    expect(flagStatus(['F1', 'F2'], ['NEED'], { F2: 'true', NEED: 'x' })).toEqual({ status: 'enabled' });
  });
  it('misconfigured when a flag is on and a requirement is missing', () => {
    expect(flagStatus(['F1'], ['NEED_A', 'NEED_B'], { F1: '1', NEED_A: 'x' })).toEqual({
      status: 'misconfigured',
      reason: 'F1 is on but NEED_B is missing',
    });
  });
  it('anyOf is enabled when any alternative is set', () => {
    expect(anyOfStatus(['A', 'B'], { B: 'x' })).toEqual({ status: 'enabled' });
    expect(anyOfStatus(['A', 'B'], {})).toEqual({ status: 'disabled' });
  });
});

describe('defineEntry', () => {
  it('rejects a status that refers to a var the entry does not list', () => {
    expect(() =>
      defineEntry({
        id: 'x',
        group: 'integrations',
        label: 'X',
        vars: [{ name: 'X_ENABLED', secret: false }],
        status: { kind: 'flags', flags: ['X_ENABLED'], requiredWhenOn: ['X_TOKEN'] },
      }),
    ).toThrow(/X_TOKEN/);
  });

  it('rejects a default-status entry with no required var', () => {
    expect(() =>
      defineEntry({ id: 'x', group: 'integrations', label: 'X', vars: [{ name: 'X_TOKEN' }] }),
    ).toThrow(/required/);
  });

  it('routes status() through the chosen spec', () => {
    const entry = defineEntry({
      id: 'x',
      group: 'integrations',
      label: 'X',
      vars: [{ name: 'X_TOKEN', required: true }],
    });
    expect(entry.status({ X_TOKEN: 't' })).toEqual({ status: 'enabled' });
    expect(entry.status({})).toEqual({ status: 'disabled' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/system/connections/statusHelpers.test.ts`
Expected: FAIL — the import of `./statusHelpers` cannot be resolved (the module does not exist yet).

- [ ] **Step 3: Write the types**

Create `apps/api/src/system/connections/types.ts`:

```ts
/**
 * Types for the System → Connections report (spec:
 * docs/superpowers/specs/platform-ci/2026-09-23-system-connections-page-design.md).
 *
 * Group ids are kebab-case and shared with the W02 web page, which localizes
 * them by id.
 */

export const CONNECTION_GROUPS = [
  'core',
  'email',
  'storage-backups',
  'ai',
  'billing',
  'microsoft-365',
  'identity-sso',
  'remote-access',
  'agent-releases',
  'observability',
  'security-abuse',
  'integrations',
] as const;

export type ConnectionGroup = (typeof CONNECTION_GROUPS)[number];

export const CONNECTION_STATUSES = ['enabled', 'disabled', 'misconfigured', 'required_missing'] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** A read-only env snapshot. `process.env` satisfies it. */
export type EnvSnapshot = Readonly<Record<string, string | undefined>>;

export type ConnectionVar = {
  /** Env var name. */
  name: string;
  /** Default true (D8). `false` means the value may be displayed. */
  secret?: boolean;
  /** Part of the "fully configured" set used by the default status helper. */
  required?: boolean;
};

export type StatusResult = {
  status: ConnectionStatus;
  /** Names env vars, never values (invariant 4). */
  reason?: string;
};

export type ConnectionEntry = {
  /** Stable kebab-case id; the web page localizes by id. */
  id: string;
  group: ConnectionGroup;
  /** English source label. */
  label: string;
  /** Path on the docs site, e.g. `/deploy/turn-server/`. A test asserts the page exists. */
  docsUrl?: string;
  /** Core services: unset => required_missing, never "disabled". */
  core?: boolean;
  vars: readonly ConnectionVar[];
  status(env: EnvSnapshot): StatusResult;
};

export type ConnectionsReportVar = {
  name: string;
  secret: boolean;
  set: boolean;
  /** Present only when `secret === false` and the value passed the value-shape guard. */
  value?: string;
};

export type ConnectionsReportEntry = {
  id: string;
  label: string;
  docsUrl?: string;
  status: ConnectionStatus;
  reason?: string;
  vars: ConnectionsReportVar[];
};

export type ConnectionsReport = {
  version: string;
  deployMode: 'hosted' | 'self_host';
  scope: 'api';
  summary: Record<ConnectionStatus, number>;
  groups: Array<{ group: ConnectionGroup; entries: ConnectionsReportEntry[] }>;
};
```

- [ ] **Step 4: Write the helpers**

Create `apps/api/src/system/connections/statusHelpers.ts`:

```ts
import type {
  ConnectionEntry,
  ConnectionGroup,
  ConnectionVar,
  EnvSnapshot,
  StatusResult,
} from './types';

/** The truthy vocabulary of `envFlag` (config/env.ts:12) and the M365 `flagEnabled` helpers. */
const TRUTHY_FLAG_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);

/** True when `name` holds a non-blank value. Never returns or logs the value. */
export function hasValue(env: EnvSnapshot, name: string): boolean {
  const raw = env[name];
  return typeof raw === 'string' && raw.trim().length > 0;
}

/**
 * D11: a var counts as set when either `NAME` or `NAME_FILE` is set. The
 * builder never opens the file — presence of the path is the whole check.
 */
export function isSet(env: EnvSnapshot, name: string): boolean {
  return hasValue(env, name) || hasValue(env, `${name}_FILE`);
}

/** Mirrors `envFlag(name)` truthiness. */
export function isFlagOn(env: EnvSnapshot, name: string): boolean {
  const raw = env[name];
  return typeof raw === 'string' && TRUTHY_FLAG_VALUES.has(raw.trim().toLowerCase());
}

/** "A", "A and B", "A, B and C". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function isOrAre(names: readonly string[]): string {
  return names.length === 1 ? 'is' : 'are';
}

/**
 * Default status (spec §1): all `required` vars set → enabled; none set →
 * disabled (core: required_missing); some set → misconfigured, naming the
 * missing vars. Optional vars never change the status, so compose defaults
 * such as `TURN_PORT=3478` cannot make an unconfigured entry look half-done.
 */
export function defaultStatus(
  entry: { core?: boolean; vars: readonly ConnectionVar[] },
  env: EnvSnapshot,
): StatusResult {
  const required = entry.vars.filter((v) => v.required).map((v) => v.name);
  const present = required.filter((name) => isSet(env, name));
  if (present.length === required.length) return { status: 'enabled' };
  if (present.length === 0) {
    return entry.core
      ? { status: 'required_missing', reason: `${listNames(required)} ${isOrAre(required)} not set` }
      : { status: 'disabled' };
  }
  const missing = required.filter((name) => !isSet(env, name));
  return {
    status: 'misconfigured',
    reason: `${listNames(present)} ${isOrAre(present)} set but ${listNames(missing)} ${isOrAre(missing)} missing`,
  };
}

/**
 * Feature-flag entries: every flag off → disabled; any flag on → enabled when
 * every `requiredWhenOn` var is set, otherwise misconfigured.
 */
export function flagStatus(
  flags: readonly string[],
  requiredWhenOn: readonly string[],
  env: EnvSnapshot,
): StatusResult {
  const on = flags.filter((flag) => isFlagOn(env, flag));
  if (on.length === 0) return { status: 'disabled' };
  const missing = requiredWhenOn.filter((name) => !isSet(env, name));
  if (missing.length === 0) return { status: 'enabled' };
  return {
    status: 'misconfigured',
    reason: `${listNames(on)} ${isOrAre(on)} on but ${listNames(missing)} ${isOrAre(missing)} missing`,
  };
}

/** Entries configured by any one of several alternative vars. */
export function anyOfStatus(names: readonly string[], env: EnvSnapshot): StatusResult {
  return names.some((name) => isSet(env, name)) ? { status: 'enabled' } : { status: 'disabled' };
}

export type StatusSpec =
  | { kind: 'default' }
  | { kind: 'flags'; flags: readonly string[]; requiredWhenOn: readonly string[] }
  | { kind: 'anyOf'; names: readonly string[] }
  | { kind: 'custom'; fn: (env: EnvSnapshot) => StatusResult };

export type EntrySpec = {
  id: string;
  group: ConnectionGroup;
  label: string;
  docsUrl?: string;
  core?: boolean;
  vars: readonly ConnectionVar[];
  status?: StatusSpec;
};

/**
 * Builds a registry entry and validates it at module load: every name a
 * status spec refers to must be one of the entry's vars, and a default-status
 * entry must mark at least one var `required`.
 */
export function defineEntry(spec: EntrySpec): ConnectionEntry {
  const names = new Set(spec.vars.map((v) => v.name));
  const statusSpec: StatusSpec = spec.status ?? { kind: 'default' };
  const referenced =
    statusSpec.kind === 'flags'
      ? [...statusSpec.flags, ...statusSpec.requiredWhenOn]
      : statusSpec.kind === 'anyOf'
        ? statusSpec.names
        : [];
  for (const name of referenced) {
    if (!names.has(name)) {
      throw new Error(`[connections] entry ${spec.id}: status refers to ${name}, which is not in its vars`);
    }
  }
  if (statusSpec.kind === 'flags' && statusSpec.flags.length === 0) {
    throw new Error(`[connections] entry ${spec.id}: a flags status needs at least one flag`);
  }
  if (statusSpec.kind === 'anyOf' && statusSpec.names.length === 0) {
    throw new Error(`[connections] entry ${spec.id}: an anyOf status needs at least one name`);
  }
  if (statusSpec.kind === 'default' && !spec.vars.some((v) => v.required)) {
    throw new Error(`[connections] entry ${spec.id}: default status needs at least one required var`);
  }

  const status = (env: EnvSnapshot): StatusResult => {
    switch (statusSpec.kind) {
      case 'default':
        return defaultStatus(spec, env);
      case 'flags':
        return flagStatus(statusSpec.flags, statusSpec.requiredWhenOn, env);
      case 'anyOf':
        return anyOfStatus(statusSpec.names, env);
      case 'custom':
        return statusSpec.fn(env);
    }
  };

  return {
    id: spec.id,
    group: spec.group,
    label: spec.label,
    ...(spec.docsUrl ? { docsUrl: spec.docsUrl } : {}),
    ...(spec.core ? { core: true } : {}),
    vars: spec.vars,
    status,
  };
}
```

- [ ] **Step 5: Run the test and confirm green**

Run: `cd apps/api && npx vitest run src/system/connections/statusHelpers.test.ts`
Expected: PASS (all `hasValue / isSet`, `isFlagOn`, `listNames`, `defaultStatus`, `flagStatus / anyOfStatus`, `defineEntry` cases).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/system/connections/types.ts apps/api/src/system/connections/statusHelpers.ts apps/api/src/system/connections/statusHelpers.test.ts
git commit -m "feat(api): connection-status types and helpers for the System page

isSet honours NAME_FILE without opening the file (D11); defineEntry
validates status specs at module load.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Resolver-mirroring status for core entries (invariant 5)

**Files:**
- Create: `apps/api/src/system/connections/customStatus.ts`
- Test: `apps/api/src/system/connections/customStatus.test.ts`

**Interfaces:**
- Consumes: `hasValue`, `isSet`, `listNames` from `./statusHelpers`; `EnvSnapshot`, `StatusResult` from `./types`; `resolveRequestDatabaseConfig(env: NodeJS.ProcessEnv): { url: string; source: 'explicit' | 'derived' | 'development-fallback' }` from `apps/api/src/db/requestDatabaseConfig.ts:113` (existing, pure, no imports).
- Produces: `databaseStatus`, `redisStatus`, `emailStatus`, `agentBinariesStatus`, `workspaceExtensionStatus`, `transportSecurityStatus` — each `(env: EnvSnapshot) => StatusResult`. Task 4 wires them into registry entries as `{ kind: 'custom', fn }`.

Resolver facts these mirror (read them before writing):
- Redis: `apps/api/src/services/redis.ts:24-31` (tolerant `production`/`prod`), `:37-39` (`BREEZE_ALLOW_UNAUTH_REDIS === 'true'`), `:83-97` (`REDIS_PASSWORD_FILE` is read — we only check presence), `:99-123` (`REDIS_URL` first, then `REDIS_HOST`/`REDIS_PORT`/password, localhost fallback).
- Database: `apps/api/src/db/requestDatabaseConfig.ts:113-140`.
- Email: `apps/api/src/services/email.ts:686-694` (selection), `:765-832` (per-provider requirements; `SMTP_USER`/`SMTP_PASS` pairing at `:793`), `:834-876` (auto-detect order resend → smtp → mailgun).
- Binary source default: `apps/api/src/services/binarySource.ts:9`. Workspace extension strict check: `apps/api/src/extensions/builtinExtensions.ts:137`. `FORCE_HTTPS`: `apps/api/src/middleware/security.ts:166-167`.
- Compose shapes: `docker-compose.yml:25-33` (DB), `:66-68` (Redis: `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD_FILE`), `:187-189` (email defaults).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/system/connections/customStatus.test.ts`:

```ts
/**
 * Invariant 5 — status truthfulness. Each core entry's status follows the
 * real resolver (spec D10), not raw env presence. Fixtures are compose-shaped
 * (docker-compose.yml:25-33, 66-68, 187-189) where that matters.
 */
import { describe, expect, it } from 'vitest';
import { resolveRequestDatabaseConfig } from '../../db/requestDatabaseConfig';
import {
  agentBinariesStatus,
  databaseStatus,
  emailStatus,
  redisStatus,
  transportSecurityStatus,
  workspaceExtensionStatus,
} from './customStatus';

describe('redisStatus (mirrors services/redis.ts resolveRedisUrl)', () => {
  it('compose-style REDIS_HOST + REDIS_PASSWORD_FILE, no REDIS_URL => enabled (file never opened)', () => {
    const env = {
      NODE_ENV: 'production',
      REDIS_HOST: 'redis',
      REDIS_PORT: '6379',
      REDIS_PASSWORD_FILE: '/nonexistent/run/secrets/redis_password',
    };
    expect(redisStatus(env).status).toBe('enabled');
  });

  it('REDIS_URL with a password => enabled', () => {
    expect(redisStatus({ NODE_ENV: 'production', REDIS_URL: 'redis://:pw@redis:6379' }).status).toBe('enabled');
  });

  it('production REDIS_URL without a password => misconfigured', () => {
    const result = redisStatus({ NODE_ENV: 'production', REDIS_URL: 'redis://redis:6379' });
    expect(result.status).toBe('misconfigured');
    expect(result.reason).toMatch(/REDIS_URL/);
  });

  it('production REDIS_HOST without any password => misconfigured, unless BREEZE_ALLOW_UNAUTH_REDIS=true', () => {
    expect(redisStatus({ NODE_ENV: 'prod', REDIS_HOST: 'redis' }).status).toBe('misconfigured');
    expect(
      redisStatus({ NODE_ENV: 'production', REDIS_HOST: 'redis', BREEZE_ALLOW_UNAUTH_REDIS: 'true' }).status,
    ).toBe('enabled');
  });

  it('development REDIS_HOST without a password => enabled (the resolver only warns outside production)', () => {
    expect(redisStatus({ NODE_ENV: 'development', REDIS_HOST: 'localhost' }).status).toBe('enabled');
  });

  it('nothing set => required_missing', () => {
    expect(redisStatus({}).status).toBe('required_missing');
  });
});

describe('databaseStatus (mirrors db/requestDatabaseConfig.ts resolveRequestDatabaseConfig)', () => {
  const composeEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://breeze:pw@postgres:5432/breeze',
    POSTGRES_PASSWORD: 'pw',
  };

  it('DATABASE_URL + POSTGRES_PASSWORD, no DATABASE_URL_APP => enabled (derived)', () => {
    expect(resolveRequestDatabaseConfig(composeEnv).source).toBe('derived');
    expect(databaseStatus(composeEnv).status).toBe('enabled');
  });

  it('explicit DATABASE_URL_APP => enabled', () => {
    const env = { ...composeEnv, POSTGRES_PASSWORD: '', DATABASE_URL_APP: 'postgresql://breeze_app:x@db:5432/breeze' };
    expect(databaseStatus(env)).toEqual({ status: 'enabled', reason: 'Request pool uses DATABASE_URL_APP' });
  });

  it('production DATABASE_URL alone => misconfigured (the resolver refuses to boot)', () => {
    const env = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://breeze:pw@postgres:5432/breeze' };
    expect(() => resolveRequestDatabaseConfig(env)).toThrow();
    expect(databaseStatus(env).status).toBe('misconfigured');
  });

  it('development DATABASE_URL alone => misconfigured (development fallback to the admin URL)', () => {
    const env = { NODE_ENV: 'development', DATABASE_URL: 'postgresql://breeze:pw@localhost:5432/breeze' };
    expect(resolveRequestDatabaseConfig(env).source).toBe('development-fallback');
    expect(databaseStatus(env).status).toBe('misconfigured');
  });

  it('invalid DATABASE_URL_APP => misconfigured naming the var', () => {
    const result = databaseStatus({ ...composeEnv, DATABASE_URL_APP: 'mysql://nope' });
    expect(result).toEqual({ status: 'misconfigured', reason: 'DATABASE_URL_APP is not a valid postgres:// URL' });
  });

  it('multi-host DATABASE_URL with a derivation password => misconfigured', () => {
    const env = { ...composeEnv, DATABASE_URL: 'postgresql://breeze:pw@db1:5432,db2:5432/breeze' };
    expect(databaseStatus(env).status).toBe('misconfigured');
  });

  it('no DATABASE_URL => required_missing', () => {
    expect(databaseStatus({ POSTGRES_PASSWORD: 'pw' }).status).toBe('required_missing');
  });
});

describe('emailStatus (mirrors services/email.ts resolveEmailProviderConfig)', () => {
  it('compose-style RESEND_API_KEY with the compose EMAIL_FROM default => enabled, provider resend', () => {
    const env = { EMAIL_PROVIDER: 'auto', RESEND_API_KEY: 're_x', EMAIL_FROM: 'noreply@breeze.local' };
    expect(emailStatus(env)).toEqual({ status: 'enabled', reason: 'Provider: resend (auto-detected)' });
  });

  it('RESEND_API_KEY with no EMAIL_FROM at all => misconfigured (the resolver throws "EMAIL_FROM is not set")', () => {
    expect(emailStatus({ RESEND_API_KEY: 're_x' })).toEqual({
      status: 'misconfigured',
      reason: 'resend is partly configured: EMAIL_FROM is missing',
    });
  });

  it('SMTP_HOST + EMAIL_FROM fallback => enabled, provider smtp', () => {
    expect(emailStatus({ SMTP_HOST: 'smtp.example.com', EMAIL_FROM: 'a@b.c' })).toEqual({
      status: 'enabled',
      reason: 'Provider: smtp (auto-detected)',
    });
  });

  it('SMTP_USER without SMTP_PASS => misconfigured', () => {
    const result = emailStatus({ SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'a@b.c', SMTP_USER: 'u' });
    expect(result.status).toBe('misconfigured');
    expect(result.reason).toMatch(/SMTP_USER and SMTP_PASS/);
  });

  it('explicit EMAIL_PROVIDER=mailgun without MAILGUN_DOMAIN => misconfigured', () => {
    const result = emailStatus({ EMAIL_PROVIDER: 'mailgun', MAILGUN_API_KEY: 'k', EMAIL_FROM: 'a@b.c' });
    expect(result).toEqual({ status: 'misconfigured', reason: 'EMAIL_PROVIDER selects mailgun but MAILGUN_DOMAIN is missing' });
  });

  it('unknown EMAIL_PROVIDER => misconfigured', () => {
    expect(emailStatus({ EMAIL_PROVIDER: 'sendgrid' }).status).toBe('misconfigured');
  });

  it('only the compose defaults (EMAIL_PROVIDER=auto, EMAIL_FROM) => required_missing', () => {
    expect(emailStatus({ EMAIL_PROVIDER: 'auto', EMAIL_FROM: 'noreply@breeze.local' }).status).toBe('required_missing');
  });
});

describe('non-core custom statuses', () => {
  it('agent binaries are always enabled; unset BINARY_SOURCE explains the default', () => {
    expect(agentBinariesStatus({}).status).toBe('enabled');
    expect(agentBinariesStatus({}).reason).toMatch(/BINARY_SOURCE/);
    expect(agentBinariesStatus({ BINARY_SOURCE: 'local' })).toEqual({ status: 'enabled' });
  });

  it('workspace extension uses the strict === "true" check of builtinExtensions.ts', () => {
    expect(workspaceExtensionStatus({ BREEZE_WORKSPACE_ENABLED: 'true' }).status).toBe('enabled');
    expect(workspaceExtensionStatus({ BREEZE_WORKSPACE_ENABLED: '1' }).status).toBe('disabled');
  });

  it('transport security needs FORCE_HTTPS and PUBLIC_API_URL', () => {
    expect(transportSecurityStatus({}).status).toBe('disabled');
    expect(transportSecurityStatus({ FORCE_HTTPS: '1' }).status).toBe('misconfigured');
    expect(transportSecurityStatus({ FORCE_HTTPS: 'true', PUBLIC_API_URL: 'https://x.example' }).status).toBe('enabled');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/system/connections/customStatus.test.ts`
Expected: FAIL — cannot load `./customStatus`.

- [ ] **Step 3: Implement**

Create `apps/api/src/system/connections/customStatus.ts`:

```ts
/**
 * Status functions that mirror the real resolvers (spec D10) instead of raw
 * `process.env` presence. Reasons name env vars, never values (invariant 4).
 *
 * These read the env snapshot only. None of them opens a `*_FILE` path (D11)
 * or logs anything.
 */
import { resolveRequestDatabaseConfig } from '../../db/requestDatabaseConfig';
import { hasValue, isSet, listNames } from './statusHelpers';
import type { EnvSnapshot, StatusResult } from './types';

// ---------------------------------------------------------------------------
// Database — mirrors resolveRequestDatabaseConfig (db/requestDatabaseConfig.ts:113-140)
// ---------------------------------------------------------------------------

export function databaseStatus(env: EnvSnapshot): StatusResult {
  if (!hasValue(env, 'DATABASE_URL')) {
    return { status: 'required_missing', reason: 'DATABASE_URL is not set' };
  }

  let source: 'explicit' | 'derived' | 'development-fallback';
  try {
    // The real resolver is pure over the env object it is given. Its error
    // messages are fixed strings, but we still never forward them.
    source = resolveRequestDatabaseConfig(env as NodeJS.ProcessEnv).source;
  } catch {
    if (hasValue(env, 'DATABASE_URL_APP')) {
      return { status: 'misconfigured', reason: 'DATABASE_URL_APP is not a valid postgres:// URL' };
    }
    if (hasValue(env, 'BREEZE_APP_DB_PASSWORD') || hasValue(env, 'POSTGRES_PASSWORD')) {
      return {
        status: 'misconfigured',
        reason: 'The request-pool URL cannot be derived from DATABASE_URL (invalid or multi-host URL); set DATABASE_URL_APP',
      };
    }
    return {
      status: 'misconfigured',
      reason: 'Production requires DATABASE_URL_APP, BREEZE_APP_DB_PASSWORD or POSTGRES_PASSWORD for the unprivileged request pool',
    };
  }

  if (source === 'explicit') return { status: 'enabled', reason: 'Request pool uses DATABASE_URL_APP' };
  if (source === 'derived') {
    return { status: 'enabled', reason: 'Request pool derived from DATABASE_URL for the breeze_app role' };
  }
  return {
    status: 'misconfigured',
    reason: 'Neither DATABASE_URL_APP nor BREEZE_APP_DB_PASSWORD/POSTGRES_PASSWORD is set; request handlers fall back to DATABASE_URL (development only)',
  };
}

// ---------------------------------------------------------------------------
// Redis — mirrors resolveRedisUrl + failOrWarnAboutInsecureRedis (services/redis.ts:24-123)
// ---------------------------------------------------------------------------

function isProductionLike(env: EnvSnapshot): boolean {
  // services/redis.ts:24-31 — tolerant match.
  const raw = (env.NODE_ENV ?? 'development').trim().toLowerCase();
  return raw === 'production' || raw === 'prod';
}

function allowsUnauthenticatedRedis(env: EnvSnapshot): boolean {
  // services/redis.ts:37-39 — strict 'true'.
  return (env.BREEZE_ALLOW_UNAUTH_REDIS ?? '').toLowerCase() === 'true';
}

function redisUrlHasPassword(url: string): boolean {
  try {
    return new URL(url).password.length > 0;
  } catch {
    return false;
  }
}

export function redisStatus(env: EnvSnapshot): StatusResult {
  const strict = isProductionLike(env) && !allowsUnauthenticatedRedis(env);

  const url = env.REDIS_URL?.trim();
  if (url) {
    if (strict && !redisUrlHasPassword(url)) {
      return {
        status: 'misconfigured',
        reason: 'REDIS_URL has no password; production refuses unauthenticated Redis unless BREEZE_ALLOW_UNAUTH_REDIS is true',
      };
    }
    return { status: 'enabled', reason: 'Using REDIS_URL' };
  }

  if (!hasValue(env, 'REDIS_HOST')) {
    return {
      status: 'required_missing',
      reason: 'Neither REDIS_URL nor REDIS_HOST is set; the API falls back to localhost:6379',
    };
  }

  // REDIS_PASSWORD or REDIS_PASSWORD_FILE (D11; the file is never opened).
  if (strict && !isSet(env, 'REDIS_PASSWORD')) {
    return {
      status: 'misconfigured',
      reason: 'REDIS_HOST is set but REDIS_PASSWORD (or REDIS_PASSWORD_FILE) is missing; production refuses unauthenticated Redis unless BREEZE_ALLOW_UNAUTH_REDIS is true',
    };
  }
  return { status: 'enabled', reason: 'Using REDIS_HOST and REDIS_PORT' };
}

// ---------------------------------------------------------------------------
// Email — mirrors resolveEmailProviderConfig (services/email.ts:686-876)
// ---------------------------------------------------------------------------

type EmailProvider = 'resend' | 'smtp' | 'mailgun';
const AUTO_DETECT_ORDER: readonly EmailProvider[] = ['resend', 'smtp', 'mailgun'];

function missingForProvider(provider: EmailProvider, env: EnvSnapshot): string[] {
  const from = hasValue(env, 'EMAIL_FROM');
  const missing: string[] = [];
  if (provider === 'resend') {
    if (!hasValue(env, 'RESEND_API_KEY')) missing.push('RESEND_API_KEY');
    if (!from) missing.push('EMAIL_FROM');
  } else if (provider === 'smtp') {
    if (!hasValue(env, 'SMTP_HOST')) missing.push('SMTP_HOST');
    if (!hasValue(env, 'SMTP_FROM') && !from) missing.push('SMTP_FROM (or EMAIL_FROM)');
  } else {
    if (!hasValue(env, 'MAILGUN_API_KEY')) missing.push('MAILGUN_API_KEY');
    if (!hasValue(env, 'MAILGUN_DOMAIN')) missing.push('MAILGUN_DOMAIN');
    if (!hasValue(env, 'MAILGUN_FROM') && !from) missing.push('MAILGUN_FROM (or EMAIL_FROM)');
  }
  return missing;
}

/** services/email.ts:793 — SMTP_PASS is checked untrimmed, SMTP_USER trimmed. */
function smtpAuthMismatch(env: EnvSnapshot): boolean {
  const user = hasValue(env, 'SMTP_USER');
  const pass = (env.SMTP_PASS ?? '').length > 0;
  return user !== pass;
}

const SMTP_AUTH_REASON = 'SMTP_USER and SMTP_PASS must both be set or both be omitted';

function isOrAre(names: readonly string[]): string {
  return names.length === 1 ? 'is' : 'are';
}

export function emailStatus(env: EnvSnapshot): StatusResult {
  const selection = (env.EMAIL_PROVIDER ?? 'auto').trim().toLowerCase();
  if (selection !== 'auto' && selection !== 'resend' && selection !== 'smtp' && selection !== 'mailgun') {
    return { status: 'misconfigured', reason: 'EMAIL_PROVIDER must be one of auto, resend, smtp, mailgun' };
  }

  if (selection !== 'auto') {
    const missing = missingForProvider(selection, env);
    if (missing.length > 0) {
      return {
        status: 'misconfigured',
        reason: `EMAIL_PROVIDER selects ${selection} but ${listNames(missing)} ${isOrAre(missing)} missing`,
      };
    }
    if (selection === 'smtp' && smtpAuthMismatch(env)) return { status: 'misconfigured', reason: SMTP_AUTH_REASON };
    return { status: 'enabled', reason: `Provider: ${selection}` };
  }

  for (const provider of AUTO_DETECT_ORDER) {
    if (missingForProvider(provider, env).length === 0) {
      if (provider === 'smtp' && smtpAuthMismatch(env)) return { status: 'misconfigured', reason: SMTP_AUTH_REASON };
      return { status: 'enabled', reason: `Provider: ${provider} (auto-detected)` };
    }
  }

  // Nothing complete. Report the first provider the operator started on.
  const started = AUTO_DETECT_ORDER.find((provider) => {
    if (provider === 'resend') return hasValue(env, 'RESEND_API_KEY');
    if (provider === 'smtp') return hasValue(env, 'SMTP_HOST');
    return hasValue(env, 'MAILGUN_API_KEY') || hasValue(env, 'MAILGUN_DOMAIN');
  });
  if (!started) {
    return {
      status: 'required_missing',
      reason: 'No email provider is configured (RESEND_API_KEY, SMTP_HOST or MAILGUN_API_KEY)',
    };
  }
  const missing = missingForProvider(started, env);
  return {
    status: 'misconfigured',
    reason: `${started} is partly configured: ${listNames(missing)} ${isOrAre(missing)} missing`,
  };
}

// ---------------------------------------------------------------------------
// Non-core entries with real logic
// ---------------------------------------------------------------------------

/** services/binarySource.ts:9 — unset falls back to the default source, so this is never "disabled". */
export function agentBinariesStatus(env: EnvSnapshot): StatusResult {
  if (!hasValue(env, 'BINARY_SOURCE')) {
    return { status: 'enabled', reason: 'BINARY_SOURCE is not set; the default source (github) is used' };
  }
  return { status: 'enabled' };
}

/** extensions/builtinExtensions.ts:137 — strict `=== 'true'`, not the envFlag vocabulary. */
export function workspaceExtensionStatus(env: EnvSnapshot): StatusResult {
  return env.BREEZE_WORKSPACE_ENABLED === 'true' ? { status: 'enabled' } : { status: 'disabled' };
}

/** middleware/security.ts:166-167 — FORCE_HTTPS is 'true' or '1'; the redirect needs PUBLIC_API_URL. */
export function transportSecurityStatus(env: EnvSnapshot): StatusResult {
  const normalized = env.FORCE_HTTPS?.trim().toLowerCase();
  const forceHttps = normalized === 'true' || normalized === '1';
  if (!forceHttps) {
    return { status: 'disabled', reason: 'FORCE_HTTPS is off; HTTPS must terminate at the reverse proxy' };
  }
  if (!hasValue(env, 'PUBLIC_API_URL')) {
    return { status: 'misconfigured', reason: 'FORCE_HTTPS is on but PUBLIC_API_URL is missing' };
  }
  return { status: 'enabled' };
}
```

- [ ] **Step 4: Run the test and confirm green**

Run: `cd apps/api && npx vitest run src/system/connections/customStatus.test.ts`
Expected: PASS — including `compose-style REDIS_HOST + REDIS_PASSWORD_FILE, no REDIS_URL => enabled`, `DATABASE_URL + POSTGRES_PASSWORD, no DATABASE_URL_APP => enabled (derived)`, `compose-style RESEND_API_KEY … => enabled, provider resend`.

- [ ] **Step 5: Mutation check (proves the truthfulness tests discriminate)**

Temporarily change `redisStatus` so `if (strict && !isSet(env, 'REDIS_PASSWORD'))` reads `if (strict && !hasValue(env, 'REDIS_PASSWORD'))` (i.e. ignore `_FILE`). Run the test file: the compose-style Redis test must FAIL. Revert and re-run: PASS. Do not commit the mutation.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/system/connections/customStatus.ts apps/api/src/system/connections/customStatus.test.ts
git commit -m "feat(api): resolver-mirroring status for database, Redis and email (D10)

Database calls resolveRequestDatabaseConfig; Redis and email mirror
resolveRedisUrl and resolveEmailProviderConfig. REDIS_PASSWORD_FILE is
presence-checked only (D11).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The registry and the secret-name guard (invariant 3)

**Files:**
- Create: `apps/api/src/system/connections/registry.ts`
- Test: `apps/api/src/system/connections/registry.test.ts`

**Interfaces:**
- Consumes: `defineEntry` (Task 2); the six status functions (Task 3); `CONNECTION_GROUPS` (Task 2).
- Produces: `CONNECTION_REGISTRY: readonly ConnectionEntry[]` (56 entries), `SECRET_NAME_PATTERN: RegExp` (spec invariant 3, verbatim), `SECRET_NAME_EXCEPTIONS: Readonly<Record<string, string>>` (24 entries). Tasks 5–7 import all three.

`docsUrl` values are paths on the docs site (`apps/docs/astro.config.mjs:5`, `site: 'https://docs.breezermm.com'`); W02 prefixes the origin. The test maps `/deploy/environment/#redis` to `apps/docs/src/content/docs/deploy/environment.mdx` and asserts the file exists (anchors are not checked).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/system/connections/registry.test.ts`:

```ts
/**
 * Registry shape + invariant 3 (secret-name guard) + docsUrl existence.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONNECTION_REGISTRY, SECRET_NAME_EXCEPTIONS, SECRET_NAME_PATTERN } from './registry';
import { CONNECTION_GROUPS } from './types';

const DOCS_CONTENT_DIR = join(__dirname, '..', '..', '..', '..', 'docs', 'src', 'content', 'docs');
const allVars = CONNECTION_REGISTRY.flatMap((entry) => entry.vars.map((v) => ({ entry: entry.id, ...v })));

describe('connection registry shape', () => {
  it('has unique kebab-case ids, known groups and non-empty labels', () => {
    const ids = CONNECTION_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of CONNECTION_REGISTRY) {
      expect(entry.id, entry.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(CONNECTION_GROUPS, entry.id).toContain(entry.group);
      expect(entry.label.trim(), entry.id).not.toBe('');
      expect(entry.vars.length, entry.id).toBeGreaterThan(0);
    }
  });

  it('lists every env var in at most one entry', () => {
    const names = allVars.map((v) => v.name);
    const dupes = names.filter((name, i) => names.indexOf(name) !== i);
    expect(dupes).toEqual([]);
  });

  it('covers every group at least once', () => {
    for (const group of CONNECTION_GROUPS) {
      expect(CONNECTION_REGISTRY.some((e) => e.group === group), group).toBe(true);
    }
  });

  it('every docsUrl points at a page that exists under apps/docs', () => {
    for (const entry of CONNECTION_REGISTRY) {
      if (!entry.docsUrl) continue;
      expect(entry.docsUrl, entry.id).toMatch(/^\/[a-z0-9-]+(\/[a-z0-9-]+)*\/(#[a-z0-9-]+)?$/);
      const pagePath = entry.docsUrl.split('#')[0]!.replace(/^\/|\/$/g, '');
      const candidates = [join(DOCS_CONTENT_DIR, `${pagePath}.mdx`), join(DOCS_CONTENT_DIR, `${pagePath}.md`), join(DOCS_CONTENT_DIR, pagePath, 'index.mdx')];
      expect(candidates.some((p) => existsSync(p)), `${entry.id} → ${entry.docsUrl}`).toBe(true);
    }
  });
});

describe('invariant 3: secret-name guard', () => {
  it('a secret-looking name stays secret unless SECRET_NAME_EXCEPTIONS explains why it is not', () => {
    const offenders = allVars
      .filter((v) => v.secret === false && SECRET_NAME_PATTERN.test(v.name) && !(v.name in SECRET_NAME_EXCEPTIONS))
      .map((v) => `${v.entry}:${v.name}`);
    expect(offenders).toEqual([]);
  });

  it('every exception is a live secret:false registry var with a reason (no stale exceptions)', () => {
    for (const [name, reason] of Object.entries(SECRET_NAME_EXCEPTIONS)) {
      const v = allVars.find((candidate) => candidate.name === name);
      expect(v, `${name} is not in the registry`).toBeDefined();
      expect(v?.secret, `${name} is excepted but not secret:false`).toBe(false);
      expect(SECRET_NAME_PATTERN.test(name), `${name} does not need an exception`).toBe(true);
      expect(reason.trim().length, name).toBeGreaterThan(10);
    }
  });

  it('the pattern catches the spec-named traps', () => {
    for (const name of ['DATABASE_URL_APP', 'FIREBASE_SERVICE_ACCOUNT', 'PLAY_INTEGRITY_SERVICE_ACCOUNT', 'CSP_REPORT_URI', 'TWILIO_ACCOUNT_SID', 'SENSITIVE_DATA_ENCRYPTION_KEY_B64']) {
      expect(SECRET_NAME_PATTERN.test(name), name).toBe(true);
      expect(allVars.find((v) => v.name === name)?.secret, name).not.toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/system/connections/registry.test.ts`
Expected: FAIL — cannot load `./registry`.

- [ ] **Step 3: Write the registry**

Create `apps/api/src/system/connections/registry.ts`. Copy it exactly; every `secret: false` line is justified in the "Every `secret: false` var, justified" table above, and a reviewer checks the two against each other.

```ts
import {
  agentBinariesStatus,
  databaseStatus,
  emailStatus,
  redisStatus,
  transportSecurityStatus,
  workspaceExtensionStatus,
} from './customStatus';
import { defineEntry } from './statusHelpers';
import type { ConnectionEntry } from './types';

/**
 * The curated connection registry (spec §1, D3). Every var is secret unless it
 * says `secret: false` (D8). Every `secret: false` line is reviewed in the PR.
 * The coverage ratchet (envInventory.test.ts) fails when an env name the API
 * reads is in neither this registry nor INTERNAL_ENV_VARS.
 */
export const CONNECTION_REGISTRY: readonly ConnectionEntry[] = [
  // ── core ────────────────────────────────────────────────────────────────
  defineEntry({
    id: 'database',
    group: 'core',
    label: 'PostgreSQL database',
    docsUrl: '/deploy/environment/#database',
    core: true,
    vars: [
      { name: 'DATABASE_URL', required: true },
      { name: 'DATABASE_URL_APP' },
      { name: 'BREEZE_APP_DB_PASSWORD' },
      { name: 'POSTGRES_PASSWORD' },
      { name: 'AUDIT_ADMIN_DATABASE_URL' },
    ],
    status: { kind: 'custom', fn: databaseStatus },
  }),
  defineEntry({
    id: 'redis',
    group: 'core',
    label: 'Redis',
    docsUrl: '/deploy/environment/#redis',
    core: true,
    vars: [
      { name: 'REDIS_URL' },
      { name: 'REDIS_HOST', secret: false },
      { name: 'REDIS_PORT', secret: false },
      { name: 'REDIS_PASSWORD' },
      { name: 'REDIS_PASSWORD_FILE' },
      { name: 'BREEZE_ALLOW_UNAUTH_REDIS', secret: false },
    ],
    status: { kind: 'custom', fn: redisStatus },
  }),
  defineEntry({
    id: 'public-urls',
    group: 'core',
    label: 'Public URLs',
    docsUrl: '/deploy/environment/#server',
    core: true,
    vars: [
      { name: 'PUBLIC_APP_URL', secret: false, required: true },
      { name: 'PUBLIC_API_URL', secret: false, required: true },
      { name: 'DASHBOARD_URL', secret: false },
      { name: 'PUBLIC_URL', secret: false },
      { name: 'PUBLIC_PORTAL_URL', secret: false },
      { name: 'PUBLIC_WEB_URL', secret: false },
      { name: 'API_URL', secret: false },
      { name: 'BREEZE_SERVER', secret: false },
      { name: 'PORTAL_BASE_PATH', secret: false },
      { name: 'PUBLIC_ACTIVATION_BASE_URL', secret: false },
      { name: 'CORS_ALLOWED_ORIGINS', secret: false },
      { name: 'CORS_INCLUDE_DEFAULT_ORIGINS', secret: false },
      { name: 'WEBAUTHN_ORIGIN', secret: false },
      { name: 'WEBAUTHN_RP_ID', secret: false },
      { name: 'WEBAUTHN_RP_NAME', secret: false },
    ],
  }),
  // ── email ───────────────────────────────────────────────────────────────
  defineEntry({
    id: 'email',
    group: 'email',
    label: 'Outbound email',
    docsUrl: '/deploy/environment/#email',
    core: true,
    vars: [
      { name: 'EMAIL_PROVIDER', secret: false },
      { name: 'EMAIL_FROM', secret: false },
      { name: 'RESEND_API_KEY' },
      { name: 'SMTP_HOST', secret: false },
      { name: 'SMTP_PORT', secret: false },
      { name: 'SMTP_SECURE', secret: false },
      { name: 'SMTP_USER' },
      { name: 'SMTP_PASS' },
      { name: 'SMTP_FROM', secret: false },
      { name: 'MAILGUN_API_KEY' },
      { name: 'MAILGUN_DOMAIN', secret: false },
      { name: 'MAILGUN_FROM', secret: false },
      { name: 'MAILGUN_BASE_URL', secret: false },
      { name: 'EMAIL_SUPPORT_ADDRESS', secret: false },
    ],
    status: { kind: 'custom', fn: emailStatus },
  }),
  defineEntry({
    id: 'partner-sending-domains',
    group: 'email',
    label: 'Partner sending domains',
    docsUrl: '/deploy/custom-sender-addresses/',
    vars: [
      { name: 'EMAIL_DOMAINS_PROVIDER', secret: false, required: true },
      { name: 'EMAIL_DOMAINS_RESEND_API_KEY' },
      { name: 'EMAIL_DOMAINS_RESEND_SENDING_KEY' },
      { name: 'EMAIL_DOMAINS_WEBHOOK_SECRET' },
      { name: 'EMAIL_DOMAINS_REGION', secret: false },
      { name: 'EMAIL_DOMAINS_STATIC_ALLOWED', secret: false },
    ],
  }),
  defineEntry({
    id: 'inbound-ticket-email',
    group: 'email',
    label: 'Inbound email-to-ticket (Mailgun)',
    docsUrl: '/deploy/environment/#inbound-email-to-ticket-mailgun',
    vars: [
      { name: 'TICKETS_INBOUND_DOMAIN', secret: false, required: true },
      { name: 'MAILGUN_INBOUND_SIGNING_KEY', required: true },
    ],
  }),
  // ── storage-backups ─────────────────────────────────────────────────────
  defineEntry({
    id: 'object-storage',
    group: 'storage-backups',
    label: 'S3-compatible object storage',
    docsUrl: '/deploy/environment/#object-storage',
    vars: [
      { name: 'S3_BUCKET', secret: false, required: true },
      { name: 'S3_ACCESS_KEY', required: true },
      { name: 'S3_SECRET_KEY', required: true },
      { name: 'S3_ENDPOINT', secret: false },
      { name: 'S3_REGION', secret: false },
      { name: 'ARTIFACT_BLOB_BACKEND', secret: false },
      { name: 'ARTIFACT_S3_ACCESS_KEY' },
      { name: 'ARTIFACT_S3_SECRET_KEY' },
      { name: 'ARTIFACT_S3_BUCKET_US', secret: false },
      { name: 'ARTIFACT_S3_BUCKET_EU', secret: false },
      { name: 'ARTIFACT_S3_ENDPOINT_US', secret: false },
      { name: 'ARTIFACT_S3_ENDPOINT_EU', secret: false },
      { name: 'ARTIFACT_S3_REGION_US', secret: false },
      { name: 'ARTIFACT_S3_REGION_EU', secret: false },
      { name: 'ARTIFACT_S3_SSE', secret: false },
    ],
  }),
  defineEntry({
    id: 'backup-failover-url',
    group: 'storage-backups',
    label: 'Backup control-plane failover URL',
    docsUrl: '/deploy/environment/#backup-enterprise-agent-backup',
    vars: [
      { name: 'AGENT_BACKUP_SERVER_URL', secret: false, required: true },
    ],
  }),
  defineEntry({
    id: 'recovery-media-signing',
    group: 'storage-backups',
    label: 'Bare-metal recovery media signing',
    vars: [
      { name: 'RECOVERY_SIGNING_PRIVATE_KEY', required: true },
      { name: 'RECOVERY_SIGNING_PUBLIC_KEY' },
      { name: 'RECOVERY_SIGNING_KEY_ID' },
      { name: 'RECOVERY_SIGNING_KEYS_JSON' },
    ],
  }),
  defineEntry({
    id: 'c2c-m365-backup',
    group: 'storage-backups',
    label: 'Microsoft 365 cloud-to-cloud backup app',
    docsUrl: '/deploy/environment/#cloud-to-cloud-backup-m365',
    vars: [
      { name: 'C2C_M365_CLIENT_ID', secret: false, required: true },
      { name: 'C2C_M365_CLIENT_SECRET', required: true },
    ],
  }),
  // ── ai ──────────────────────────────────────────────────────────────────
  defineEntry({
    id: 'anthropic',
    group: 'ai',
    label: 'Anthropic (platform AI key)',
    docsUrl: '/deploy/environment/#ai',
    vars: [
      { name: 'ANTHROPIC_API_KEY', required: true },
      { name: 'ANTHROPIC_AUTH_TOKEN' },
      { name: 'ANTHROPIC_BASE_URL', secret: false },
      { name: 'ANTHROPIC_MODEL', secret: false },
    ],
  }),
  defineEntry({
    id: 'openai-compatible-llm',
    group: 'ai',
    label: 'Alternative LLM backend (OpenAI-compatible)',
    docsUrl: '/deploy/environment/#self-hosted-alternative-anthropic-compatible-backends',
    vars: [
      { name: 'MCP_LLM_BASE_URL', secret: false, required: true },
      { name: 'MCP_LLM_PROVIDER', secret: false },
      { name: 'MCP_LLM_API_KEY' },
      { name: 'MCP_LLM_MODEL', secret: false },
      { name: 'MCP_LLM_PRICE_INPUT_PER_M_USD', secret: false },
      { name: 'MCP_LLM_PRICE_OUTPUT_PER_M_USD', secret: false },
    ],
  }),
  defineEntry({
    id: 'llm-provider-catalog',
    group: 'ai',
    label: 'LLM provider catalog',
    vars: [
      { name: 'LLM_PROVIDER_CATALOG_ENABLED', secret: false },
    ],
    status: {
      kind: 'flags',
      flags: ['LLM_PROVIDER_CATALOG_ENABLED'],
      requiredWhenOn: [],
    },
  }),
  defineEntry({
    id: 'ai-agents',
    group: 'ai',
    label: 'AI agents',
    docsUrl: '/deploy/environment/#ai-operator-preview-off-by-default',
    vars: [
      { name: 'BREEZE_AI_AGENTS_ENABLED', secret: false },
      { name: 'BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED', secret: false },
      { name: 'BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED', secret: false },
      { name: 'BREEZE_AI_SCRIPT_AUTHORING_ENABLED', secret: false },
      { name: 'BREEZE_AI_SCRIPT_REVIEWER_MODEL', secret: false },
      { name: 'AI_OPERATOR_TASKS_ENABLED', secret: false },
      { name: 'AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED', secret: false },
    ],
    status: {
      kind: 'flags',
      flags: ['BREEZE_AI_AGENTS_ENABLED'],
      requiredWhenOn: [],
    },
  }),
  defineEntry({
    id: 'ai-workspace-sandbox',
    group: 'ai',
    label: 'AI workspace sandbox',
    vars: [
      { name: 'BREEZE_AI_WORKSPACE_ENABLED', secret: false },
      { name: 'AI_WORKSPACE_BACKEND', secret: false },
      { name: 'VERCEL_SANDBOX_TOKEN' },
      { name: 'VERCEL_TEAM_ID' },
      { name: 'VERCEL_PROJECT_ID' },
      { name: 'VERCEL_SANDBOX_IMAGE', secret: false },
      { name: 'VERCEL_SANDBOX_REGION_US', secret: false },
      { name: 'VERCEL_SANDBOX_REGION_EU', secret: false },
    ],
    status: {
      kind: 'flags',
      flags: ['BREEZE_AI_WORKSPACE_ENABLED'],
      requiredWhenOn: [],
    },
  }),
  defineEntry({
    id: 'workspace-extension',
    group: 'ai',
    label: 'Workspace extension (pgvector)',
    vars: [
      { name: 'BREEZE_WORKSPACE_ENABLED', secret: false },
    ],
    status: { kind: 'custom', fn: workspaceExtensionStatus },
  }),
  defineEntry({
    id: 'tool-sources',
    group: 'ai',
    label: 'External MCP tool sources',
    vars: [
      { name: 'TOOL_SOURCES_ENABLED', secret: false },
      { name: 'TOOL_SOURCES_ALLOW_PRIVATE_EGRESS', secret: false },
    ],
    status: {
      kind: 'flags',
      flags: ['TOOL_SOURCES_ENABLED'],
      requiredWhenOn: [],
    },
  }),
  // ── billing ─────────────────────────────────────────────────────────────
  defineEntry({
    id: 'breeze-billing',
    group: 'billing',
    label: 'Breeze billing service',
    docsUrl: '/deploy/environment/#billing',
    vars: [
      { name: 'BREEZE_BILLING_URL', secret: false, required: true },
      { name: 'BREEZE_BILLING_API_KEY', required: true },
      { name: 'BILLING_URL', secret: false },
    ],
  }),
  defineEntry({
    id: 'ai-cost-billing',
    group: 'billing',
    label: 'AI usage metering',
    vars: [
      { name: 'BILLING_SERVICE_URL', secret: false, required: true },
      { name: 'BILLING_SERVICE_API_KEY', required: true },
    ],
  }),
  defineEntry({
    id: 'stripe',
    group: 'billing',
    label: 'Stripe',
    vars: [
      { name: 'STRIPE_SECRET_KEY', required: true },
      { name: 'STRIPE_WEBHOOK_SECRET', required: true },
      { name: 'STRIPE_SESSION_REVOCATION_MODE', secret: false },
      { name: 'STRIPE_ACCOUNT_CACHE_REFRESH_ENABLED', secret: false },
    ],
  }),
  defineEntry({
    id: 'quickbooks',
    group: 'billing',
    label: 'QuickBooks Online',
    docsUrl: '/deploy/environment/#accounting-quickbooks-online',
    vars: [
      { name: 'QBO_CLIENT_ID', secret: false, required: true },
      { name: 'QBO_CLIENT_SECRET', required: true },
      { name: 'QBO_REDIRECT_URI', secret: false },
      { name: 'QBO_ENVIRONMENT', secret: false },
      { name: 'QBO_WEBHOOK_VERIFIER_TOKEN' },
    ],
  }),
  // ── microsoft-365 ───────────────────────────────────────────────────────
  defineEntry({
    id: 'm365-identity-tools',
    group: 'microsoft-365',
    label: 'Microsoft 365 identity tools',
    vars: [
      { name: 'M365_ENABLED', secret: false },
    ],
    status: {
      kind: 'flags',
      flags: ['M365_ENABLED'],
      requiredWhenOn: [],
    },
  }),
  defineEntry({
    id: 'm365-tenant-sync',
    group: 'microsoft-365',
    label: 'Microsoft 365 tenant sync',
    docsUrl: '/deploy/environment/#api-side-tenant-sync',
    vars: [
      { name: 'M365_TENANT_SYNC_ENABLED', secret: false },
    ],
    status: {
      kind: 'flags',
      flags: ['M365_TENANT_SYNC_ENABLED'],
      requiredWhenOn: [],
    },
  }),
  defineEntry({
    id: 'm365-graph-read',
    group: 'microsoft-365',
    label: 'Customer Graph read (executor)',
    docsUrl: '/deploy/environment/#customer-microsoft-365-graph-read-consent-optional',
    vars: [
      { name: 'M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED', secret: false },
      { name: 'M365_GRAPH_READ_TOOLS_ENABLED', secret: false },
      { name: 'M365_CUSTOMER_GRAPH_READ_CLIENT_ID', secret: false },
      { name: 'M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION' },
      { name: 'M365_CUSTOMER_GRAPH_READ_VAULT_REF' },
      { name: 'M365_GRAPH_READ_EXECUTOR_URL' },
      { name: 'M365_GRAPH_READ_EXECUTOR_AUDIENCE', secret: false },
      { name: 'M365_GRAPH_READ_EXECUTOR_SIGNING_KID' },
      { name: 'M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE' },
      { name: 'M365_CUSTOMER_GRAPH_READ_ONBOARDING_ORG_IDS', secret: false },
      { name: 'M365_GRAPH_READ_TOOLS_ORG_IDS', secret: false },
    ],
    status: {
      kind: 'flags',
      flags: ['M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED', 'M365_GRAPH_READ_TOOLS_ENABLED'],
      requiredWhenOn: [
        'M365_CUSTOMER_GRAPH_READ_CLIENT_ID',
        'M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION',
        'M365_CUSTOMER_GRAPH_READ_VAULT_REF',
        'M365_GRAPH_READ_EXECUTOR_URL',
        'M365_GRAPH_READ_EXECUTOR_AUDIENCE',
        'M365_GRAPH_READ_EXECUTOR_SIGNING_KID',
        'M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE',
      ],
    },
  }),
  defineEntry({
    id: 'm365-graph-actions',
    group: 'microsoft-365',
    label: 'Customer Graph actions (write executor)',
    docsUrl: '/deploy/environment/#customer-microsoft-365-graph-actions-write-executor-optional',
    vars: [
      { name: 'M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED', secret: false },
      { name: 'M365_GRAPH_ACTIONS_TOOLS_ENABLED', secret: false },
      { name: 'M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID', secret: false },
      { name: 'M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION' },
      { name: 'M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF' },
      { name: 'M365_GRAPH_ACTIONS_EXECUTOR_URL' },
      { name: 'M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE', secret: false },
      { name: 'M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_KID' },
      { name: 'M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE' },
      { name: 'M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ORG_IDS', secret: false },
      { name: 'M365_GRAPH_ACTIONS_TOOLS_ORG_IDS', secret: false },
    ],
    status: {
      kind: 'flags',
      flags: ['M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED', 'M365_GRAPH_ACTIONS_TOOLS_ENABLED'],
      requiredWhenOn: [
        'M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID',
        'M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION',
        'M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF',
        'M365_GRAPH_ACTIONS_EXECUTOR_URL',
        'M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE',
        'M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_KID',
        'M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE',
      ],
    },
  }),
  defineEntry({
    id: 'm365-comms',
    group: 'microsoft-365',
    label: 'Microsoft 365 comms (executor)',
    vars: [
      { name: 'M365_COMMS_ONBOARDING_ENABLED', secret: false },
      { name: 'M365_COMMS_TOOLS_ENABLED', secret: false },
      { name: 'M365_COMMS_CLIENT_ID', secret: false },
      { name: 'M365_COMMS_EXECUTOR_URL' },
      { name: 'M365_COMMS_EXECUTOR_AUDIENCE', secret: false },
      { name: 'M365_COMMS_EXECUTOR_SIGNING_KID' },
      { name: 'M365_COMMS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE' },
      { name: 'M365_COMMS_ONBOARDING_USER_IDS', secret: false },
      { name: 'M365_COMMS_TOOLS_USER_IDS', secret: false },
    ],
    status: {
      kind: 'flags',
      flags: ['M365_COMMS_ONBOARDING_ENABLED', 'M365_COMMS_TOOLS_ENABLED'],
      requiredWhenOn: [
        'M365_COMMS_CLIENT_ID',
        'M365_COMMS_EXECUTOR_URL',
        'M365_COMMS_EXECUTOR_AUDIENCE',
        'M365_COMMS_EXECUTOR_SIGNING_KID',
        'M365_COMMS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE',
      ],
    },
  }),
  defineEntry({
    id: 'ticket-mailbox-m365',
    group: 'microsoft-365',
    label: 'Ticket mailbox (Microsoft 365)',
    docsUrl: '/deploy/environment/#ticket-mailbox-m365-email-to-ticket',
    vars: [
      { name: 'TICKET_MAILBOX_M365_CLIENT_ID', secret: false, required: true },
      { name: 'TICKET_MAILBOX_M365_CLIENT_SECRET', required: true },
    ],
  }),
  // ── identity-sso ────────────────────────────────────────────────────────
  defineEntry({
    id: 'signing-keys',
    group: 'identity-sso',
    label: 'Signing and encryption keys',
    docsUrl: '/deploy/environment/#authentication--security',
    core: true,
    vars: [
      { name: 'JWT_SECRET', required: true },
      { name: 'APP_ENCRYPTION_KEY', required: true },
      { name: 'MFA_ENCRYPTION_KEY', required: true },
      { name: 'JWT_SIGNING_KEYRING' },
      { name: 'JWT_ACTIVE_KID' },
      { name: 'APP_ENCRYPTION_KEY_ID' },
      { name: 'APP_ENCRYPTION_KEYRING' },
      { name: 'SECRET_ENCRYPTION_KEY' },
      { name: 'SECRET_ENCRYPTION_KEYRING' },
      { name: 'SECRET_ENCRYPTION_KEY_ID' },
      { name: 'SSO_ENCRYPTION_KEY' },
      { name: 'SESSION_SECRET' },
      { name: 'PARTNER_API_CURSOR_SIGNING_KEY' },
      { name: 'ENROLLMENT_KEY_PEPPER' },
      { name: 'MFA_RECOVERY_CODE_PEPPER' },
    ],
  }),
  defineEntry({
    id: 'agent-enrollment-secret',
    group: 'identity-sso',
    label: 'Agent enrollment secret',
    vars: [
      { name: 'AGENT_ENROLLMENT_SECRET', required: true },
      { name: 'ENROLLMENT_SECRET_ENFORCEMENT_MODE', secret: false },
    ],
  }),
  defineEntry({
    id: 'cloudflare-access',
    group: 'identity-sso',
    label: 'Cloudflare Access trust',
    docsUrl: '/deploy/cloudflare-access-trust/',
    vars: [
      { name: 'CF_ACCESS_TRUST_ENABLED', secret: false },
      { name: 'CF_ACCESS_TEAM_DOMAIN', secret: false },
      { name: 'CF_ACCESS_AUD' },
      { name: 'CF_ACCESS_TRUSTS_MFA', secret: false },
    ],
    status: {
      kind: 'flags',
      flags: ['CF_ACCESS_TRUST_ENABLED'],
      requiredWhenOn: [
        'CF_ACCESS_TEAM_DOMAIN',
        'CF_ACCESS_AUD',
      ],
    },
  }),
  defineEntry({
    id: 'client-ai-entra',
    group: 'identity-sso',
    label: 'Breeze AI for Office (Entra app)',
    docsUrl: '/deploy/environment/#breeze-ai-for-office-add-ins-optional',
    vars: [
      { name: 'CLIENT_AI_ENTRA_CLIENT_ID', secret: false, required: true },
    ],
  }),
  defineEntry({
    id: 'twilio',
    group: 'identity-sso',
    label: 'Twilio SMS',
    docsUrl: '/deploy/environment/#sms-twilio',
    vars: [
      { name: 'TWILIO_ACCOUNT_SID', required: true },
      { name: 'TWILIO_AUTH_TOKEN', required: true },
      { name: 'TWILIO_MESSAGING_SERVICE_SID' },
      { name: 'TWILIO_VERIFY_SERVICE_SID' },
      { name: 'TWILIO_PHONE_NUMBER', secret: false },
    ],
  }),
  defineEntry({
    id: 'mobile-attestation',
    group: 'identity-sso',
    label: 'Mobile app attestation',
    vars: [
      { name: 'PLAY_INTEGRITY_SERVICE_ACCOUNT', required: true },
      { name: 'APPLE_APP_ATTEST_APP_ID', secret: false, required: true },
      { name: 'APPLE_APP_ATTEST_ENVIRONMENT', secret: false },
      { name: 'BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED', secret: false },
    ],
  }),
  // ── remote-access ───────────────────────────────────────────────────────
  defineEntry({
    id: 'turn',
    group: 'remote-access',
    label: 'TURN relay',
    docsUrl: '/deploy/turn-server/',
    vars: [
      { name: 'TURN_HOST', secret: false, required: true },
      { name: 'TURN_SECRET', required: true },
      { name: 'TURN_PORT', secret: false },
      { name: 'TURN_TLS_HOST', secret: false },
      { name: 'TURN_TLS_PORT', secret: false },
      { name: 'TURN_TLS_DIR', secret: false },
    ],
  }),
  // ── agent-releases ──────────────────────────────────────────────────────
  defineEntry({
    id: 'agent-binaries',
    group: 'agent-releases',
    label: 'Agent binary source',
    docsUrl: '/deploy/binaries/',
    vars: [
      { name: 'BINARY_SOURCE', secret: false },
      { name: 'BINARY_GITHUB_REPOSITORY', secret: false },
      { name: 'GITHUB_REPO', secret: false },
      { name: 'BINARY_VERSION', secret: false },
      { name: 'BREEZE_VERSION', secret: false },
      { name: 'BINARY_EDITION', secret: false },
      { name: 'AGENT_AUTO_PROMOTE', secret: false },
      { name: 'GITHUB_TOKEN' },
      { name: 'GH_TOKEN' },
    ],
    status: { kind: 'custom', fn: agentBinariesStatus },
  }),
  defineEntry({
    id: 'update-manifest-signing',
    group: 'agent-releases',
    label: 'Update manifest signing keys',
    docsUrl: '/deploy/code-signing/',
    vars: [
      { name: 'AGENT_UPDATE_MANIFEST_PUBLIC_KEYS' },
      { name: 'BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS' },
      { name: 'RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS' },
      { name: 'BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS' },
      { name: 'RELEASE_ARTIFACT_MANIFEST_VERIFICATION', secret: false },
      { name: 'AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID' },
    ],
    status: {
      kind: 'anyOf',
      names: [
        'AGENT_UPDATE_MANIFEST_PUBLIC_KEYS',
        'BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS',
        'RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS',
        'BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS',
      ],
    },
  }),
  // ── observability ───────────────────────────────────────────────────────
  defineEntry({
    id: 'sentry',
    group: 'observability',
    label: 'Sentry',
    docsUrl: '/security/error-tracking/',
    vars: [
      { name: 'SENTRY_DSN', required: true },
      { name: 'SENTRY_ENVIRONMENT', secret: false },
      { name: 'SENTRY_TRACES_SAMPLE_RATE', secret: false },
      { name: 'SENTRY_PROFILES_SAMPLE_RATE', secret: false },
    ],
  }),
  defineEntry({
    id: 'metrics-scrape',
    group: 'observability',
    label: 'Prometheus metrics scrape',
    docsUrl: '/monitoring/stack/',
    vars: [
      { name: 'METRICS_SCRAPE_TOKEN', required: true },
      { name: 'METRICS_SCRAPE_IP_ALLOWLIST', secret: false },
    ],
  }),
  defineEntry({
    id: 'ops-alerts',
    group: 'observability',
    label: 'Operator alerts',
    vars: [
      { name: 'OPS_ALERT_EMAIL', secret: false },
      { name: 'OPS_ALERT_WEBHOOK_URL' },
      { name: 'OPS_ALERT_LABEL', secret: false },
    ],
    status: {
      kind: 'anyOf',
      names: [
        'OPS_ALERT_EMAIL',
        'OPS_ALERT_WEBHOOK_URL',
      ],
    },
  }),
  defineEntry({
    id: 'csp-reporting',
    group: 'observability',
    label: 'CSP violation reporting',
    vars: [
      { name: 'CSP_REPORT_URI', required: true },
    ],
  }),
  // ── security-abuse ──────────────────────────────────────────────────────
  defineEntry({
    id: 'transport-security',
    group: 'security-abuse',
    label: 'HTTPS and proxy trust',
    docsUrl: '/deploy/tls/',
    vars: [
      { name: 'FORCE_HTTPS', secret: false },
      { name: 'TRUST_PROXY_HEADERS', secret: false },
      { name: 'TRUSTED_PROXY_CIDRS', secret: false },
      { name: 'TRUST_CF_CONNECTING_IP', secret: false },
    ],
    status: { kind: 'custom', fn: transportSecurityStatus },
  }),
  defineEntry({
    id: 'cloudflare-mtls',
    group: 'security-abuse',
    label: 'Cloudflare mTLS for agents',
    docsUrl: '/security/mtls/',
    vars: [
      { name: 'CLOUDFLARE_API_TOKEN', required: true },
      { name: 'CLOUDFLARE_ZONE_ID', required: true },
      { name: 'AGENT_MTLS_BINDING_MODE', secret: false },
    ],
  }),
  defineEntry({
    id: 'abuse-signals',
    group: 'security-abuse',
    label: 'Signup abuse signals',
    vars: [
      { name: 'ABUSE_SIGNALS_ENABLED', secret: false },
    ],
    status: {
      kind: 'flags',
      flags: ['ABUSE_SIGNALS_ENABLED'],
      requiredWhenOn: [],
    },
  }),
  defineEntry({
    id: 'ip-classify',
    group: 'security-abuse',
    label: 'IP reputation lookup',
    vars: [
      { name: 'IP_CLASSIFY_PROVIDER', secret: false, required: true },
      { name: 'IP_CLASSIFY_API_KEY' },
    ],
  }),
  defineEntry({
    id: 'sensitive-data-keys',
    group: 'security-abuse',
    label: 'Sensitive-data encryption keys',
    vars: [
      { name: 'SENSITIVE_DATA_ENCRYPTION_KEY_B64' },
      { name: 'SENSITIVE_DATA_KEYRING_JSON' },
      { name: 'SENSITIVE_DATA_ENCRYPTION_KEY_REF' },
      { name: 'SENSITIVE_DATA_ENCRYPTION_KEY_VERSION' },
    ],
    status: {
      kind: 'anyOf',
      names: [
        'SENSITIVE_DATA_ENCRYPTION_KEY_B64',
        'SENSITIVE_DATA_KEYRING_JSON',
      ],
    },
  }),
  defineEntry({
    id: 'audit-anchor-signing',
    group: 'security-abuse',
    label: 'Audit-chain anchor signing',
    vars: [
      { name: 'AUDIT_ANCHOR_SIGNING_KEY', required: true },
    ],
  }),
  // ── integrations ────────────────────────────────────────────────────────
  defineEntry({
    id: 'delegant',
    group: 'integrations',
    label: 'Delegant',
    vars: [
      { name: 'DELEGANT_BASE_URL', secret: false, required: true },
      { name: 'DELEGANT_SERVICE_TOKEN', required: true },
      { name: 'DELEGANT_PRINCIPAL_KID' },
      { name: 'DELEGANT_PRINCIPAL_SIGNING_KEY' },
      { name: 'DELEGANT_AGENT_ID' },
      { name: 'DELEGANT_ACTING_USER_ID' },
    ],
  }),
  defineEntry({
    id: 'mcp-oauth',
    group: 'integrations',
    label: 'MCP server OAuth',
    docsUrl: '/deploy/environment/#mcp-server',
    vars: [
      { name: 'MCP_OAUTH_ENABLED', secret: false },
      { name: 'OAUTH_ISSUER', secret: false },
      { name: 'OAUTH_RESOURCE_URL', secret: false },
      { name: 'OAUTH_CONSENT_URL_BASE', secret: false },
      { name: 'OAUTH_COOKIE_SECRET' },
      { name: 'OAUTH_JWKS_PRIVATE_JWK' },
      { name: 'OAUTH_JWKS_PUBLIC_JWK' },
      { name: 'OAUTH_DCR_ENABLED', secret: false },
      { name: 'OAUTH_DCR_ALLOW_ANONYMOUS', secret: false },
      { name: 'OAUTH_DCR_REQUIRE_IAT', secret: false },
    ],
    status: {
      kind: 'flags',
      flags: ['MCP_OAUTH_ENABLED'],
      requiredWhenOn: [
        'OAUTH_COOKIE_SECRET',
        'OAUTH_JWKS_PRIVATE_JWK',
      ],
    },
  }),
  defineEntry({
    id: 'google-workspace-tools',
    group: 'integrations',
    label: 'Google Workspace tools',
    vars: [
      { name: 'GOOGLE_WORKSPACE_ENABLED', secret: false },
    ],
    status: {
      kind: 'flags',
      flags: ['GOOGLE_WORKSPACE_ENABLED'],
      requiredWhenOn: [],
    },
  }),
  defineEntry({
    id: 'partner-hooks',
    group: 'integrations',
    label: 'Partner lifecycle hooks',
    vars: [
      { name: 'PARTNER_HOOKS_URL', required: true },
      { name: 'PARTNER_HOOKS_SECRET', required: true },
    ],
  }),
  defineEntry({
    id: 'apns',
    group: 'integrations',
    label: 'Apple push notifications (APNs)',
    docsUrl: '/deploy/environment/#mobile-push-notifications-ios',
    vars: [
      { name: 'APNS_AUTH_KEY', required: true },
      { name: 'APNS_KEY_ID', required: true },
      { name: 'APNS_TEAM_ID', secret: false, required: true },
      { name: 'APNS_BUNDLE_ID', secret: false },
      { name: 'APNS_ENVIRONMENT', secret: false },
    ],
  }),
  defineEntry({
    id: 'fcm',
    group: 'integrations',
    label: 'Firebase Cloud Messaging',
    docsUrl: '/deploy/environment/#mobile-push-notifications-android',
    vars: [
      { name: 'FIREBASE_SERVICE_ACCOUNT', required: true },
    ],
  }),
  defineEntry({
    id: 'warranty-dell',
    group: 'integrations',
    label: 'Dell warranty lookup',
    docsUrl: '/deploy/environment/#warranty-lookups',
    vars: [
      { name: 'DELL_CLIENT_ID', secret: false, required: true },
      { name: 'DELL_CLIENT_SECRET', required: true },
    ],
  }),
  defineEntry({
    id: 'warranty-lenovo',
    group: 'integrations',
    label: 'Lenovo warranty lookup',
    docsUrl: '/deploy/environment/#warranty-lookups',
    vars: [
      { name: 'LENOVO_API_KEY', required: true },
      { name: 'LENOVO_WARRANTY_ENABLED', secret: false },
    ],
  }),
  defineEntry({
    id: 'warranty-hp',
    group: 'integrations',
    label: 'HP warranty lookup',
    docsUrl: '/deploy/environment/#warranty-lookups',
    vars: [
      { name: 'HP_WARRANTY_ENABLED', secret: false },
    ],
    status: {
      kind: 'flags',
      flags: ['HP_WARRANTY_ENABLED'],
      requiredWhenOn: [],
    },
  }),
  defineEntry({
    id: 'nvd',
    group: 'integrations',
    label: 'NVD vulnerability feed',
    docsUrl: '/deploy/environment/#vulnerability-management',
    vars: [
      { name: 'NVD_API_KEY', required: true },
    ],
  }),
];

/**
 * Invariant 3: a `secret: false` var whose name matches SECRET_NAME_PATTERN
 * must be listed here with the reason its value is safe to show.
 */
export const SECRET_NAME_PATTERN =
  /SECRET|KEY|TOKEN|PASS|PRIVATE|DSN|CREDENTIAL|URL|URI|ENDPOINT|SERVICE_ACCOUNT|JWK|SID|WEBHOOK|SIGNING|CERT|SALT|SEED|ENCRYPT|JSON|B64|BASE64/;

export const SECRET_NAME_EXCEPTIONS: Readonly<Record<string, string>> = {
  PUBLIC_APP_URL: 'public web-app origin, shown to operators already in every email link',
  PUBLIC_API_URL: 'public API origin, embedded in agent installers',
  DASHBOARD_URL: 'public web-app origin (legacy alias of PUBLIC_APP_URL)',
  PUBLIC_URL: 'public origin fallback for OAuth/SSO callbacks',
  PUBLIC_PORTAL_URL: 'public customer-portal origin',
  PUBLIC_WEB_URL: 'public web-app origin for support-session links',
  API_URL: 'public API origin override for agent downloads',
  PUBLIC_ACTIVATION_BASE_URL: 'public activation-landing origin',
  MAILGUN_BASE_URL: 'public Mailgun API base (US or EU region)',
  S3_ENDPOINT: 'object-storage endpoint host; values with URL userinfo are refused at runtime',
  ARTIFACT_S3_ENDPOINT_US: 'object-storage endpoint host; values with URL userinfo are refused at runtime',
  ARTIFACT_S3_ENDPOINT_EU: 'object-storage endpoint host; values with URL userinfo are refused at runtime',
  AGENT_BACKUP_SERVER_URL: 'public failover URL that is pushed to every agent',
  ANTHROPIC_BASE_URL: 'LLM gateway base URL; values with URL userinfo are refused at runtime',
  MCP_LLM_BASE_URL: 'LLM gateway base URL; values with URL userinfo are refused at runtime',
  TOOL_SOURCES_ALLOW_PRIVATE_EGRESS: 'boolean flag; "PRIVATE" names the network class, not a key',
  BREEZE_BILLING_URL: 'billing service base URL; values with URL userinfo are refused at runtime',
  BILLING_URL: 'public payment-setup landing URL',
  BILLING_SERVICE_URL: 'metering service base URL; values with URL userinfo are refused at runtime',
  QBO_REDIRECT_URI: 'public OAuth redirect URI registered with Intuit',
  ENROLLMENT_SECRET_ENFORCEMENT_MODE: 'enum (enforce/warn); "SECRET" names the thing it enforces',
  DELEGANT_BASE_URL: 'Delegant service base URL; values with URL userinfo are refused at runtime',
  OAUTH_RESOURCE_URL: 'public OAuth resource identifier',
  OAUTH_CONSENT_URL_BASE: 'public OAuth consent page origin',
};
```

- [ ] **Step 4: Run the test and confirm green**

Run: `cd apps/api && npx vitest run src/system/connections/registry.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Mutation check**

Temporarily change `{ name: 'CSP_REPORT_URI', required: true }` to `{ name: 'CSP_REPORT_URI', secret: false, required: true }`. Run: the `a secret-looking name stays secret …` test must FAIL listing `csp-reporting:CSP_REPORT_URI`, and `the pattern catches the spec-named traps` must FAIL. Revert; PASS again.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/system/connections/registry.ts apps/api/src/system/connections/registry.test.ts
git commit -m "feat(api): System page connection registry, default-deny secrecy

56 entries across 12 groups. Secret-looking names stay secret unless
SECRET_NAME_EXCEPTIONS explains why (invariant 3); docsUrl pages must
exist under apps/docs.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `INTERNAL_ENV_VARS` and the coverage ratchet (invariant 1)

**Files:**
- Create: `apps/api/src/system/connections/internalEnvVars.ts`
- Test: `apps/api/src/system/connections/envInventory.test.ts`

**Interfaces:**
- Consumes: `CONNECTION_REGISTRY` (Task 4); `ENV_SCHEMA_KEYS: readonly string[]` from `apps/api/src/config/validate.ts:2338` (already imported by `config/validate.test.ts:5`); `BUILTINS: readonly BuiltinExtension[]` with `enableEnvVar: string` from `apps/api/src/extensions/builtinRegistry.ts:238` (already imported by `extensions/builtinExtensions.test.ts:17`). The directory-walk pattern mirrors `apps/api/src/oauth/revocationCallsites.test.ts:5-25`.
- Produces: `INTERNAL_ENV_VARS: Readonly<Record<string, string>>` (338 entries). Nothing later imports it except this test.

- [ ] **Step 1: Write the failing ratchet test**

Create `apps/api/src/system/connections/envInventory.test.ts`:

```ts
/**
 * Invariant 1 — coverage ratchet. Every env name the API source reads must be
 * classified: in CONNECTION_REGISTRY (shown on the System page) or in
 * INTERNAL_ENV_VARS (deliberately not shown). Fails on unclassified names, on
 * stale names no longer read anywhere, and on names classified twice.
 *
 * Scan: every .ts file under apps/api/src except *.test.ts, src/__tests__/ and this
 * feature's own directory (its status code names env vars on purpose and
 * would otherwise keep stale names alive). Plus every ENV_SCHEMA_KEYS key and
 * every builtin extension enableEnvVar, enumerated from the source of truth.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_SCHEMA_KEYS } from '../../config/validate';
import { BUILTINS } from '../../extensions/builtinRegistry';
import { INTERNAL_ENV_VARS } from './internalEnvVars';
import { CONNECTION_REGISTRY } from './registry';

const SRC_DIR = join(__dirname, '..', '..');
const SELF_DIR = relative(SRC_DIR, __dirname).split(sep).join('/');

const NAME = String.raw`([A-Z][A-Z0-9_]*)(?![A-Za-z0-9_])`;

/**
 * Every env read shape the codebase uses. Each regex captures the name in
 * group 1 or 2. Spec invariant 1 lists the first two shapes; the rest were
 * found by the W01 inventory (see the plan's "Ratchet scan shapes" table).
 */
const SCAN_SHAPES: Readonly<Record<string, RegExp>> = {
  // process.env.X, process.env['X'], process.env["X"]
  processEnv: new RegExp(String.raw`\bprocess\.env(?:\.${NAME}|\[\s*['"]${NAME}['"]\s*\])`, 'g'),
  // Literal first (or second, after a prefix/label arg) argument to any helper whose name contains
  // Env/env/Knob/TimeoutMs: envFlag, envInt, envStr, envFloat, getEnvString, positiveIntEnv,
  // cronFromEnv, envString, envHours, parsePositiveIntEnv(LOG_PREFIX, 'X'), resolveMsKnob,
  // parseTransportTimeoutMs, platformEnv, positiveIntFromEnv, readPositiveIntEnv, ...
  envHelper: new RegExp(
    String.raw`(?<![\w$])[\w$]*(?:[Ee]nv|Knob|TimeoutMs)[\w$]*\(\s*(?:[A-Za-z_$][\w$.]*\s*,\s*)?['"]${NAME}['"]`,
    'g',
  ),
  // An env object passed around as `env` or `source`: env.X, source.X, env['X'], source?.X
  envAlias: new RegExp(String.raw`(?<![\w$])(?:env|source)(?:\??\.${NAME}|\[\s*['"]${NAME}['"]\s*\])`, 'g'),
  // Helpers that take the env object first: required(source, 'X'), requiredEnum(source, 'X', ...)
  envObjectArg: new RegExp(String.raw`(?<![\w$])[A-Za-z_$][\w$]*\(\s*(?:process\.env|env|source)\s*,\s*['"]${NAME}['"]`, 'g'),
  // Named constants holding an env name: const MAX_ATTEMPTS_ENV = 'X', UNSAFE_DB_ROLE_OPT_OUT_ENV = 'X'
  envNameConst: new RegExp(String.raw`\b[A-Z0-9_]*ENV[A-Z0-9_]*\s*(?::\s*string\s*)?=\s*['"]${NAME}['"]`, 'g'),
};

/**
 * Tokens the scan produces that are not env names. Each must still be produced
 * by the scan (checked below), so this list cannot rot either.
 */
const SCAN_NOISE: Readonly<Record<string, string>> = {
  BUCKET: "suffix in envFor(region, 'BUCKET') (services/artifacts/blobStorage.ts); real names ARTIFACT_S3_BUCKET_{US,EU} are schema keys",
  ENDPOINT: "suffix in envFor(region, 'ENDPOINT') (services/artifacts/blobStorage.ts); real names are schema keys",
  REGION: "suffix in envFor(region, 'REGION') (services/artifacts/blobStorage.ts); real names are schema keys",
  KEY: 'docblock text `env.KEY` in config/validate.ts (ENV_SCHEMA_KEYS comment)',
  X: 'docblock example `process.env.X` (utils/envFloat.ts, routes/installer.ts, ...)',
  SOME_TTL_MINUTES: 'docblock anti-example `process.env.SOME_TTL_MINUTES` in utils/envInt.ts',
};

function productionSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(dir, entry.name);
    const rel = relative(SRC_DIR, absolute).split(sep).join('/');
    if (entry.isDirectory()) {
      if (rel === '__tests__' || rel === SELF_DIR) return [];
      return productionSourceFiles(absolute);
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [absolute];
  });
}

function scanEnvNames(): Set<string> {
  const names = new Set<string>();
  for (const file of productionSourceFiles(SRC_DIR)) {
    const source = readFileSync(file, 'utf8');
    for (const shape of Object.values(SCAN_SHAPES)) {
      for (const match of source.matchAll(shape)) {
        const name = match[1] ?? match[2];
        if (name) names.add(name);
      }
    }
  }
  for (const key of ENV_SCHEMA_KEYS) names.add(key);
  for (const builtin of BUILTINS) names.add(builtin.enableEnvVar);
  return names;
}

const scanned = scanEnvNames();
const registryNames = CONNECTION_REGISTRY.flatMap((entry) => entry.vars.map((v) => v.name));
const registrySet = new Set(registryNames);
const internalNames = Object.keys(INTERNAL_ENV_VARS);

describe('invariant 1: env coverage ratchet', () => {
  it('finds a realistic inventory (guards a broken scan that finds nothing)', () => {
    expect(scanned.size).toBeGreaterThan(500);
    expect(scanned.has('DATABASE_URL')).toBe(true); // process.env.X
    expect(scanned.has('ENABLE_REGISTRATION')).toBe(true); // envFlag('X')
    expect(scanned.has('M365_COMMS_EXECUTOR_URL')).toBe(true); // required(source, 'X')
    expect(scanned.has('AGENT_LOG_RETENTION_BATCH_SIZE')).toBe(true); // parsePositiveIntEnv(PREFIX, 'X')
    expect(scanned.has('BREEZE_WORKSPACE_ENABLED')).toBe(true); // builtin enableEnvVar
  });

  it('includes every ENV_SCHEMA_KEYS key and every builtin enableEnvVar', () => {
    expect(ENV_SCHEMA_KEYS.length).toBeGreaterThan(90);
    expect(BUILTINS.length).toBeGreaterThan(0);
    for (const key of ENV_SCHEMA_KEYS) expect(scanned.has(key), key).toBe(true);
    for (const builtin of BUILTINS) expect(scanned.has(builtin.enableEnvVar), builtin.enableEnvVar).toBe(true);
  });

  it('every env name the API reads is in the registry or INTERNAL_ENV_VARS', () => {
    const unclassified = [...scanned]
      .filter((name) => !registrySet.has(name) && !(name in INTERNAL_ENV_VARS) && !(name in SCAN_NOISE))
      .sort();
    // To fix: add the name to CONNECTION_REGISTRY (operator-facing, secret by
    // default) or to INTERNAL_ENV_VARS with a one-phrase reason.
    expect(unclassified).toEqual([]);
  });

  it('has no stale registry vars (named in the registry but read nowhere)', () => {
    expect(registryNames.filter((name) => !scanned.has(name)).sort()).toEqual([]);
  });

  it('has no stale INTERNAL_ENV_VARS entries', () => {
    expect(internalNames.filter((name) => !scanned.has(name)).sort()).toEqual([]);
  });

  it('classifies no name twice', () => {
    expect(internalNames.filter((name) => registrySet.has(name)).sort()).toEqual([]);
    expect(registryNames.filter((name, i) => registryNames.indexOf(name) !== i)).toEqual([]);
  });

  it('every internal entry carries a reason', () => {
    for (const [name, reason] of Object.entries(INTERNAL_ENV_VARS)) {
      expect(reason.trim().length, name).toBeGreaterThan(3);
    }
  });

  it('SCAN_NOISE tokens are still produced by the scan and are not classified', () => {
    for (const token of Object.keys(SCAN_NOISE)) {
      expect(scanned.has(token), `${token} no longer appears; drop it from SCAN_NOISE`).toBe(true);
      expect(registrySet.has(token) || token in INTERNAL_ENV_VARS, token).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Create an empty internal list and watch the ratchet fail**

Create `apps/api/src/system/connections/internalEnvVars.ts` with only:

```ts
export const INTERNAL_ENV_VARS: Readonly<Record<string, string>> = {};
```

Run: `cd apps/api && npx vitest run src/system/connections/envInventory.test.ts`
Expected: FAIL, 1 test — `every env name the API reads is in the registry or INTERNAL_ENV_VARS` lists the unclassified names (338 at plan time, `ABUSE_HOSTNAME_INDICATORS` … `WS_TICKET_BIND_IP`; vitest may truncate the diff). The other 7 tests pass (the registry has no stale names and the scan finds > 500 names). If the unclassified count is not 338, `git log origin/main -- apps/api/src` has moved since 2026-09-23: classify each extra name (registry if operator-facing — secret by default — otherwise internal with a reason) and drop any name the stale checks report; note the delta in the PR body.

- [ ] **Step 3: Fill the internal list**

Replace `apps/api/src/system/connections/internalEnvVars.ts` with:

```ts
/**
 * Env vars the API reads that are NOT operator-facing connections (spec §1):
 * tuning knobs, job toggles, rollout flags, test/dev hooks. One phrase each.
 * Names only — nothing here is ever read or displayed by the report.
 * The coverage ratchet (envInventory.test.ts) keeps this list honest: a name
 * that stops appearing in apps/api/src fails the "stale" check.
 */
export const INTERNAL_ENV_VARS: Readonly<Record<string, string>> = {
  // ABUSE_*
  ABUSE_HOSTNAME_INDICATORS: 'abuse heuristic tuning list',
  ABUSE_SCRIPT_INDICATORS: 'abuse heuristic tuning list',
  ABUSE_SIGNAL_OVERRIDES: 'abuse heuristic weight overrides',
  // AGENT_*
  AGENT_BINARY_DIR: 'filesystem path',
  AGENT_EDITION_AUTO_MIGRATE_ENABLED: 'agent edition migration toggle',
  AGENT_LOG_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  AGENT_LOG_RETENTION_DAYS: 'data retention window',
  AGENT_LOG_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  AGENT_ORG_RATE_LIMIT_MAX: 'rate limit knob',
  AGENT_ORG_RATE_LIMIT_PER_DEVICE: 'rate limit knob',
  AGENT_ORG_RATE_LIMIT_PER_MIN: 'rate limit knob',
  AGENT_TOKEN_ROTATION_MAX_AGE_DAYS: 'agent token rotation window',
  // AI_*
  AI_COMPUTE_PRICE_MULTIPLIER: 'AI billing price multiplier',
  AI_TOOL_EVAL_KEY: 'dev script (services/llm/__scripts__)',
  // ALERT_*
  ALERT_WORKER_CHUNK_SIZE: 'worker throughput knob',
  ALERT_WORKER_MAX_DEVICES_PER_RUN: 'worker throughput knob',
  // API_*
  API_KEY_PRELOOKUP_RATE_LIMIT: 'rate limit knob',
  API_KEY_PRELOOKUP_RATE_WINDOW_SECONDS: 'rate limit knob',
  API_PORT: 'listen port',
  // APP_*
  APP_VERSION: 'shown as report.version',
  // AUDIT_*
  AUDIT_CHAIN_ANCHOR_ENABLED: 'audit job kill switch',
  AUDIT_CHAIN_VERIFY_ENABLED: 'audit job toggle',
  AUDIT_CHAIN_VERIFY_MODE: 'audit job mode',
  AUDIT_CHAIN_VERIFY_RESCAN_SLICES: 'audit job tuning',
  AUDIT_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  AUDIT_RETENTION_ENABLED: 'audit job toggle',
  AUDIT_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // AUTH_*
  AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED: 'auth rollout switch',
  AUTH_COOKIE_FORCE_SECURE: 'cookie policy override',
  AUTH_COOKIE_SAME_SITE: 'cookie policy override',
  AUTH_LEGACY_INVITE_PREVIEW_PATH: 'legacy route toggle',
  AUTH_REFRESH_RATE_LIMIT: 'rate limit knob',
  AUTH_REFRESH_RATE_WINDOW_SECONDS: 'rate limit knob',
  AUTH_TRANSITION_TEST_CONTROL_SECRET: 'test-only barrier secret',
  // AUTOMATION_*
  AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET: 'legacy compatibility toggle',
  AUTOMATION_WEBHOOK_ALLOW_LOCAL_REPLAY_FALLBACK: 'legacy compatibility toggle',
  // AUTO_*
  AUTO_MIGRATE: 'boot migration toggle',
  // BACKUP_*
  BACKUP_BASE_LEASE_MS: 'timing knob',
  BACKUP_BINARY_DIR: 'filesystem path',
  BACKUP_CRITICAL_DEVICE_TAGS: 'backup criticality tuning',
  BACKUP_GC_GRACE_MS: 'timing knob',
  BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS: 'timing knob',
  BACKUP_GC_MAX_DELETES_PER_RUN: 'worker throughput knob',
  BACKUP_GC_ORPHAN_MANIFEST_MAX_AGE_MS: 'timing knob',
  BACKUP_PUBLISH_MARGIN_MS: 'timing knob',
  BACKUP_RESTORE_PIN_LINGER_MS: 'timing knob',
  // BINARY_*
  BINARY_CHECKSUM_MANIFEST: 'binary checksum manifest override',
  BINARY_VERSION_FILE: 'build metadata path',
  // BMR_*
  BMR_RECOVERY_ADVERTISE_QUERY_TOKEN: 'recovery compatibility toggle',
  BMR_RECOVERY_ALLOW_QUERY_TOKEN: 'recovery compatibility toggle',
  // BREEZE_*
  BREEZE_ALLOW_UNSAFE_DB_ROLE: 'non-production safety opt-out',
  BREEZE_BOOTSTRAP_ADMIN_EMAIL: 'one-time first-boot seed',
  BREEZE_BOOTSTRAP_ADMIN_NAME: 'one-time first-boot seed',
  BREEZE_BOOTSTRAP_ADMIN_PASSWORD: 'one-time first-boot seed',
  BREEZE_BUILTIN_MONITORS_AUTOSEED: 'seed toggle',
  BREEZE_INTEGRATION_ALLOW_LEDGER_DRIFT: 'test harness (testUtils)',
  BREEZE_INTEGRATION_LOCK_NOWAIT: 'test harness (testUtils)',
  BREEZE_PLATFORM_ADMINS: 'platform-admin bootstrap list',
  BREEZE_REGION: 'hosted topology label',
  BREEZE_ROLE: 'process role (api/worker)',
  BREEZE_SEED_E2E_FORCE: 'E2E seed toggle',
  BREEZE_TEST_DB_URL: 'test harness (testUtils)',
  BREEZE_UPGRADE_PREFLIGHT_STRICT: 'upgrade CLI flag',
  // CALLER_*
  CALLER_VERIFICATION_ENABLED: 'feature flag',
  // CANCEL_*
  CANCEL_GRACE_MS: 'timing knob',
  // CHANGE_*
  CHANGE_INGEST_MAX_BODY_BYTES: 'ingest size limit',
  CHANGE_INGEST_MAX_DECOMPRESSED_BYTES: 'ingest size limit',
  CHANGE_INGEST_MAX_ITEMS: 'ingest size limit',
  CHANGE_LOG_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  CHANGE_LOG_RETENTION_DAYS: 'data retention window',
  CHANGE_LOG_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // CHILD_*
  CHILD_ENROLLMENT_KEY_TTL_MINUTES: 'timing knob',
  // CLAUDE_*
  CLAUDE_AGENT_SDK_CLIENT_APP: 'SDK child-process label',
  // COOKIE_*
  COOKIE_FORCE_SECURE: 'cookie policy override',
  COOKIE_SAME_SITE: 'cookie policy override',
  // CSP_*
  CSP_ALLOW_UNSAFE_INLINE: 'CSP tuning',
  CSP_CONNECT_HOSTS: 'CSP tuning',
  // DB_*
  DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS: 'database pool/watchdog tuning',
  DB_CONTEXTLESS_WRITE_STRICT: 'database pool/watchdog tuning',
  DB_CONTEXT_HELD_CAPTURE_THROTTLE_MS: 'database pool/watchdog tuning',
  DB_CONTEXT_HELD_WARN_MS: 'database pool/watchdog tuning',
  DB_CONTEXT_TRIPWIRE_STRICT: 'database pool/watchdog tuning',
  DB_POOL_HEALTH_CAPTURE_THROTTLE_MS: 'database pool/watchdog tuning',
  DB_POOL_HEALTH_DISABLED: 'database pool/watchdog tuning',
  DB_POOL_HEALTH_INTERVAL_MS: 'database pool/watchdog tuning',
  DB_POOL_HEALTH_MIN_TIMEOUTS: 'database pool/watchdog tuning',
  DB_POOL_HEALTH_PROBE_TIMEOUT_MS: 'database pool/watchdog tuning',
  DB_POOL_HEALTH_WINDOW_MS: 'database pool/watchdog tuning',
  DB_POOL_MAX: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_CONFIRM_DELAY_MS: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_MIN_AGE_MS: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_RECLAIM_DISABLED: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_RECLAIM_MAX_PER_PASS: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_RECLAIM_MIN_INTERVAL_MS: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_RECLAIM_TIMEOUT_MS: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_SCANNER_RECLAIM_DISABLED: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_SCAN_DISABLED: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_SCAN_INTERVAL_MS: 'database pool/watchdog tuning',
  // DEPLOYMENT_*
  DEPLOYMENT_ENV: 'hosted topology label',
  // DEVICE_*
  DEVICE_COMMAND_QUEUE_LIVE_ONLY_TTL_MINUTES: 'timing knob',
  DEVICE_COMMAND_QUEUE_POWER_STATE_TTL_HOURS: 'timing knob',
  DEVICE_COMMAND_QUEUE_SHORT_TTL_HOURS: 'timing knob',
  DEVICE_COMMAND_QUEUE_TTL_HOURS: 'timing knob',
  DEVICE_METRICS_RETENTION_DAYS: 'data retention window',
  DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS: 'timing knob',
  // DEV_*
  DEV_PUSH_ENABLED: 'developer agent push toggle',
  // E2E_*
  E2E_MODE: 'E2E test mode',
  // EMAIL_*
  EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE: 'sending-domain policy knob',
  EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS: 'sending-domain policy knob',
  EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES: 'sending-domain policy knob',
  EMAIL_DOMAINS_DAILY_SEND_CAP: 'sending-domain policy knob',
  EMAIL_DOMAINS_DENYLIST: 'sending-domain policy knob',
  EMAIL_DOMAINS_MAX_PER_PARTNER: 'sending-domain policy knob',
  EMAIL_DOMAINS_PARTNER_ALLOWLIST: 'sending-domain policy knob',
  // ENABLE_*
  ENABLE_2FA: 'auth policy flag',
  ENABLE_AAD_V3: 'crypto format rollout flag',
  ENABLE_AI_PATCH_TESTING: 'feature flag',
  ENABLE_API_DOCS_UI: 'feature flag',
  ENABLE_REGISTRATION: 'signup policy flag',
  ENABLE_TOOL_SEARCH: 'dev script (services/llm/__scripts__)',
  // ENROLLMENT_*
  ENROLLMENT_KEY_CLEANUP_ENABLED: 'cleanup job toggle',
  ENROLLMENT_KEY_DEFAULT_TTL_MINUTES: 'timing knob',
  ENROLLMENT_KEY_PURGE_AFTER_DAYS: 'data retention window',
  // EVENT_*
  EVENT_DISPATCH_MODE: 'event bus mode',
  EVENT_DISPATCH_QUEUE_SUBSCRIBERS: 'event bus routing',
  EVENT_LOG_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  EVENT_LOG_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  EVENT_LOOP_MONITOR_DISABLED: 'event-loop monitor toggle',
  EVENT_LOOP_MONITOR_INTERVAL_MS: 'event-loop monitor tuning',
  EVENT_LOOP_STARVATION_THROTTLE_MS: 'event-loop monitor tuning',
  EVENT_LOOP_STARVATION_WARN_MS: 'event-loop monitor tuning',
  EVENT_PERMISSION_EPOCH_MODE: 'event bus mode',
  // EVIDENCE_*
  EVIDENCE_STORAGE_ALLOWED_SCHEMES: 'validation allowlist',
  // EXCHANGE_*
  EXCHANGE_RATE_SYNC_ENABLED: 'job toggle',
  // FILESYSTEM_*
  FILESYSTEM_ANALYSIS_AUTO_RESUME_MAX_RUNS: 'agent analysis tuning',
  FILESYSTEM_ANALYSIS_DISK_THRESHOLD: 'agent analysis tuning',
  FILESYSTEM_ANALYSIS_THRESHOLD_COOLDOWN_MINUTES: 'timing knob',
  FILESYSTEM_CLEANUP_PLAN_RETENTION_DAYS: 'data retention window',
  FILESYSTEM_CLEANUP_PREVIEW_RETENTION_DAYS: 'data retention window',
  FILESYSTEM_CLEANUP_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  FILESYSTEM_CLEANUP_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // FRANKFURTER_*
  FRANKFURTER_BASE_URL: 'FX API base override',
  // HELPER_*
  HELPER_BINARY_DIR: 'filesystem path',
  // HTTPS_*
  HTTPS_PROXY: 'egress proxy passthrough',
  // HTTP_*
  HTTP_PROXY: 'egress proxy passthrough',
  // INBOUND_*
  INBOUND_QUEUE_MAX_PER_SEC: 'rate limit knob',
  // INCIDENT_*
  INCIDENT_CORRELATION_INTERVAL_MS: 'timing knob',
  INCIDENT_SLA_MONITOR_INTERVAL_MS: 'timing knob',
  INCIDENT_SLA_P1_MINUTES: 'incident SLA tuning',
  INCIDENT_SLA_P2_MINUTES: 'incident SLA tuning',
  INCIDENT_TIMELINE_ENRICH_INTERVAL_MS: 'timing knob',
  // INSTALLER_*
  INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES: 'timing knob',
  INSTALLER_PARENT_MIN_REMAINING_SECONDS: 'timing knob',
  // INTENT_*
  INTENT_OUTBOX_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  INTENT_OUTBOX_RETENTION_DAYS: 'data retention window',
  INTENT_OUTBOX_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // IP_*
  IP_ALLOWLIST_ENFORCEMENT_MODE: 'enforcement mode',
  IP_HISTORY_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  IP_HISTORY_RETENTION_DAYS: 'data retention window',
  IP_HISTORY_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // IS_*
  IS_HOSTED: 'shown as report.deployMode',
  // LLM_*
  LLM_FIDELITY_API_KEY: 'dev script (services/llm/__scripts__)',
  LLM_FIDELITY_AUTH_MODE: 'dev script (services/llm/__scripts__)',
  LLM_FIDELITY_BASE_URL: 'dev script (services/llm/__scripts__)',
  LLM_FIDELITY_PROVIDER_MODEL: 'dev script (services/llm/__scripts__)',
  // LOGIN_*
  LOGIN_ACCOUNT_LOCKOUT_MAX: 'rate limit knob',
  LOGIN_ACCOUNT_LOCKOUT_WINDOW_SECONDS: 'rate limit knob',
  // LOG_*
  LOG_LEVEL: 'logging verbosity',
  // M365_*
  M365_SYNC_CONCURRENCY: 'worker throughput knob',
  M365_SYNC_MAX_BACKLOG: 'worker throughput knob',
  M365_SYNC_TICK_BATCH: 'worker throughput knob',
  // MACOS_*
  MACOS_INSTALLER_ALLOW_LEGACY_GET_BOOTSTRAP: 'legacy compatibility toggle',
  // MAILGUN_*
  MAILGUN_TIMEOUT_MS: 'timing knob',
  // MANAGED_*
  MANAGED_SOFTWARE_POLICY_MODE: 'enforcement mode',
  // MAX_*
  MAX_ACTIVE_REMOTE_SESSIONS_PER_ORG: 'rate limit knob',
  MAX_ACTIVE_REMOTE_SESSIONS_PER_USER: 'rate limit knob',
  // MCP_*
  MCP_EXECUTE_TOOL_ALLOWLIST: 'MCP tool policy',
  MCP_MAX_SSE_SESSIONS_PER_KEY: 'rate limit knob',
  MCP_MESSAGE_MAX_BODY_BYTES: 'request size limit',
  MCP_MESSAGE_RATE_LIMIT_PER_MINUTE: 'rate limit knob',
  MCP_REQUIRE_EXECUTE_ADMIN: 'MCP tool policy',
  MCP_SESSION_TTL_SECONDS: 'timing knob',
  MCP_SSE_RATE_LIMIT_PER_MINUTE: 'rate limit knob',
  MCP_TOOLS_LIST_PAGE_SIZE: 'paging knob',
  MCP_UNKNOWN_SESSION_ALERT_THRESHOLD: 'alert threshold',
  // METRICS_*
  METRICS_ACTIVE_DEVICE_WINDOW_SECONDS: 'timing knob',
  METRICS_FLEET_GAUGE_TIMEOUT_SECONDS: 'timing knob',
  METRICS_FLEET_GAUGE_TTL_SECONDS: 'timing knob',
  METRICS_INCLUDE_ORG_ID: 'metrics label toggle',
  // METRIC_*
  METRIC_ANOMALY_EPISODE_ASSEMBLY_LOOKBACK_HOURS: 'timing knob',
  METRIC_ANOMALY_EPISODE_CLEAN_BUCKETS: 'anomaly episode tuning',
  METRIC_ANOMALY_EPISODE_EXPIRE_HOURS: 'timing knob',
  METRIC_ANOMALY_EPISODE_GAP_MINUTES: 'timing knob',
  METRIC_ANOMALY_EPISODE_RECURRENCE_DAYS: 'timing knob',
  METRIC_ANOMALY_EPISODE_SNOOZE_DAYS: 'timing knob',
  METRIC_ANOMALY_INCIDENT_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  METRIC_ANOMALY_INCIDENT_RETENTION_DAYS: 'data retention window',
  METRIC_ANOMALY_INCIDENT_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  METRIC_ROLLUP_5M_RETENTION_DAYS: 'data retention window',
  METRIC_ROLLUP_DAILY_RETENTION_DAYS: 'data retention window',
  METRIC_ROLLUP_DELETE_BATCH_SIZE: 'retention sweep batch knob',
  METRIC_ROLLUP_HOURLY_RETENTION_DAYS: 'data retention window',
  METRIC_ROLLUP_MAINTENANCE_CRON: 'job schedule override',
  METRIC_ROLLUP_MAINTENANCE_ENABLED: 'job toggle',
  METRIC_ROLLUP_MAX_DELETE_BATCHES: 'retention sweep batch knob',
  METRIC_ROLLUP_PARTITION_MONTHS_AHEAD: 'partition maintenance tuning',
  METRIC_ROLLUP_PARTITION_MONTHS_BACK: 'partition maintenance tuning',
  // MFA_*
  MFA_FORCE_FOR_PARTNER_ADMIN: 'auth policy flag',
  // ML_*
  ML_DISABLED_FLAGS: 'ML kill switch',
  ML_FEATURES_DISABLED: 'ML kill switch',
  ML_GLOBAL_KILL_SWITCH: 'ML kill switch',
  ML_OUTPUTS_DISABLED: 'ML kill switch',
  ML_OUTPUT_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  ML_OUTPUT_RETENTION_CRON: 'job schedule override',
  ML_OUTPUT_RETENTION_DAYS: 'data retention window',
  ML_OUTPUT_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // MONITOR_*
  MONITOR_EPISODE_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  MONITOR_EPISODE_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // NODE_*
  NODE_ENV: 'runtime mode',
  // NO_*
  NO_PROXY: 'egress proxy passthrough',
  // OAUTH_*
  OAUTH_AUTH_EPOCH_ENFORCE_AFTER: 'OAuth rollout cutoff',
  OAUTH_CLEANUP_ENABLED: 'cleanup job toggle',
  OAUTH_DEBUG: 'debug logging flag',
  // OFFBOARDING_*
  OFFBOARDING_DRAIN_WINDOW_HOURS: 'timing knob',
  // OFFLINE_*
  OFFLINE_DETECTOR_CHUNK_SIZE: 'worker throughput knob',
  OFFLINE_DETECTOR_MAX_DEVICES_PER_RUN: 'worker throughput knob',
  OFFLINE_DETECTOR_REEVAL_CHUNK_SIZE: 'worker throughput knob',
  OFFLINE_DETECTOR_REEVAL_ENABLED: 'job toggle',
  OFFLINE_DETECTOR_REEVAL_HORIZON_MINUTES: 'timing knob',
  OFFLINE_DETECTOR_REEVAL_INTERVAL_MS: 'timing knob',
  OFFLINE_DETECTOR_REEVAL_MAX_DEVICES_PER_RUN: 'worker throughput knob',
  OFFLINE_DETECTOR_WORKER_CONCURRENCY: 'worker throughput knob',
  // ORG_*
  ORG_ARCHIVE_DEFAULT_RETENTION_DAYS: 'data retention window',
  ORG_MERGE_FENCE_DRAIN_MS: 'timing knob',
  ORG_MERGE_MAX_ROWS: 'org merge safety limit',
  // PAM_*
  PAM_ACTUATOR_ENABLED: 'feature flag',
  PAM_PENDING_REQUEST_TTL_MINUTES: 'timing knob',
  // PARTNER_*
  PARTNER_API_ENROLLMENT_KEY_MAX_TTL_MINUTES: 'timing knob',
  PARTNER_API_ENROLLMENT_KEY_WRITE_PARTNER_RATE_LIMIT: 'rate limit knob',
  PARTNER_API_ENROLLMENT_KEY_WRITE_RATE_LIMIT: 'rate limit knob',
  PARTNER_MEETING_URL: 'partner onboarding copy link',
  PARTNER_TRUST_MODE: 'hosted partner trust mode',
  // PATCH_*
  PATCH_REPORT_STORAGE_PATH: 'filesystem path',
  PATCH_TOMBSTONE_PRUNE_AFTER_HOURS: 'data retention window',
  // PENDING_*
  PENDING_ACCOUNT_MEETING_LABEL: 'partner onboarding copy',
  PENDING_ACCOUNT_MEETING_URL: 'partner onboarding copy link',
  // PERIPHERAL_*
  PERIPHERAL_ANOMALY_BLOCKED_THRESHOLD: 'alert threshold',
  // PORTAL_*
  PORTAL_COOKIE_FORCE_SECURE: 'cookie policy override',
  PORTAL_COOKIE_SAME_SITE: 'cookie policy override',
  PORTAL_STATE_BACKEND: 'portal rate-limit store selector',
  // PROCESS_*
  PROCESS_SAMPLE_RETENTION_DAYS: 'data retention window',
  // PROVISION_*
  PROVISION_HANDLE_TTL_MINUTES: 'timing knob',
  // READINESS_*
  READINESS_CACHE_TTL_MS: 'timing knob',
  READINESS_PROBE_TIMEOUT_MS: 'timing knob',
  // RECORDING_*
  RECORDING_URL_ALLOWED_ORIGINS: 'validation allowlist',
  // RECOVERY_*
  RECOVERY_MEDIA_WORK_DIR: 'filesystem path',
  RECOVERY_MINISIGN_BIN: 'filesystem path',
  // REFRESH_*
  REFRESH_FAMILY_ABSOLUTE_TTL_DAYS: 'timing knob',
  REFRESH_ROTATION_GRACE_SECONDS: 'timing knob',
  // RELIABILITY_*
  RELIABILITY_HISTORY_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  RELIABILITY_HISTORY_RETENTION_DAYS: 'data retention window',
  RELIABILITY_HISTORY_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // REMOTE_*
  REMOTE_ACCESS_ADMISSION_MODE: 'remote access rollout mode',
  REMOTE_DESKTOP_FENCE_REQUIRED: 'remote access rollout flag',
  REMOTE_WS_AUTH_MODE: 'remote access rollout mode',
  REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT: 'remote access rollout marker',
  REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT: 'remote access rollout marker',
  REMOTE_WS_REDIS_TOPOLOGY: 'remote access topology assertion',
  // REMOVED_*
  REMOVED_DEVICE_PURGE_MAX_PER_ORG_PER_RUN: 'worker throughput knob',
  // REQUIRE_*
  REQUIRE_DB_ON_STARTUP: 'boot strictness flag',
  REQUIRE_REDIS_ON_STARTUP: 'boot strictness flag',
  // S1_*
  S1_SYNC_MAX_PAGES: 'sync paging limit',
  // S3_*
  S3_PRESIGN_TTL: 'timing knob',
  // SCREENSHOT_*
  SCREENSHOT_STORAGE_DIR: 'filesystem path',
  // SCRIPT_*
  SCRIPT_VERIFY_RECONCILE_MIN_AGE_MINUTES: 'timing knob',
  // SECURITY_*
  SECURITY_POSTURE_ON_DEMAND_DEDUPE_WINDOW_MS: 'timing knob',
  SECURITY_POSTURE_WORKER_CONCURRENCY: 'worker throughput knob',
  SECURITY_SCAN_DEVICE_CONCURRENCY_CAP: 'worker throughput knob',
  SECURITY_SCAN_ORG_CONCURRENCY_CAP: 'worker throughput knob',
  SECURITY_SCAN_ORG_QUEUE_BACKPRESSURE_LIMIT: 'worker throughput knob',
  SECURITY_SCAN_THROTTLE_REQUEUE_SECONDS: 'timing knob',
  SECURITY_SCAN_WORKER_CONCURRENCY: 'worker throughput knob',
  SECURITY_SCORE_CHANGE_EVENT_LIMIT: 'worker throughput knob',
  SECURITY_SCORE_CHANGE_PUBLISH_CONCURRENCY: 'worker throughput knob',
  // SENSITIVE_*
  SENSITIVE_DATA_DEVICE_CONCURRENCY_CAP: 'worker throughput knob',
  SENSITIVE_DATA_ORG_CONCURRENCY_CAP: 'worker throughput knob',
  SENSITIVE_DATA_ORG_QUEUE_BACKPRESSURE_LIMIT: 'worker throughput knob',
  SENSITIVE_DATA_REQUIRE_SECOND_APPROVAL: 'approval policy flag',
  SENSITIVE_DATA_SECOND_APPROVAL_TOKEN: 'approval policy secret (names only)',
  SENSITIVE_DATA_THROTTLE_REQUEUE_SECONDS: 'timing knob',
  SENSITIVE_DATA_WORKER_CONCURRENCY: 'worker throughput knob',
  // SERVICE_*
  SERVICE_PROCESS_CHECK_RESULTS_RETENTION_DAYS: 'data retention window',
  // SHUTDOWN_*
  SHUTDOWN_DRAIN_MS: 'timing knob',
  // SIGNUP_*
  SIGNUP_ALLOWED_EMAIL_DOMAINS: 'signup policy list',
  SIGNUP_BUSINESS_EMAIL_CONTACT_URL: 'signup policy copy link',
  SIGNUP_EXTRA_CONSUMER_EMAIL_DOMAINS: 'signup policy list',
  SIGNUP_REQUIRE_BUSINESS_EMAIL: 'signup policy flag',
  // SMTP_*
  SMTP_TIMEOUT_MS: 'timing knob',
  // SNMP_*
  SNMP_METRICS_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  SNMP_METRICS_RETENTION_DAYS: 'data retention window',
  SNMP_METRICS_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // SOFTWARE_*
  SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS: 'remediation retry limit',
  SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS: 'worker throughput knob',
  SOFTWARE_REMEDIATION_REQUEST_CLEANUP_ENABLED: 'cleanup job toggle',
  SOFTWARE_REMEDIATION_REQUEST_RETENTION_HOURS: 'data retention window',
  SOFTWARE_UPLOAD_SESSION_CLEANUP_ENABLED: 'cleanup job toggle',
  SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS: 'timing knob',
  SOFTWARE_UPLOAD_SESSION_MAX_AGE_HOURS: 'timing knob',
  // SSO_*
  SSO_DOMAIN_VERIFICATION_STRICT: 'SSO policy flag',
  // STALE_*
  STALE_REAPER_MAX_PER_RUN: 'worker throughput knob',
  // SYNTHETIC_*
  SYNTHETIC_TEST_IP_ALLOWLIST: 'synthetic monitor access',
  SYNTHETIC_TEST_TOKEN: 'synthetic monitor secret (names only)',
  // TD_*
  TD_SYNNEX_DIGITAL_BRIDGE_TIMEOUT_MS: 'timing knob',
  // TICKET_*
  TICKET_OUTBOX_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  TICKET_OUTBOX_RETENTION_DAYS: 'data retention window',
  TICKET_OUTBOX_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // TOPOLOGY_*
  TOPOLOGY_DISABLED: 'feature kill switch',
  // TRUST_*
  TRUST_ACTION_TOKEN_SECRET: 'hosted partner-trust secret (names only)',
  // TURN_*
  TURN_CREDENTIAL_TTL_SECONDS: 'timing knob',
  // UNINSTALL_*
  UNINSTALL_INTENT_DECOMMISSION_HOURS: 'timing knob',
  UNINSTALL_INTENT_REAP_CHUNK_SIZE: 'worker throughput knob',
  UNINSTALL_INTENT_REAP_INTERVAL_MS: 'timing knob',
  UNINSTALL_INTENT_REAP_MAX_DEVICES_PER_RUN: 'worker throughput knob',
  // USER_*
  USER_RISK_ON_DEMAND_DEDUPE_WINDOW_MS: 'timing knob',
  USER_RISK_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  USER_RISK_RETENTION_CRON: 'job schedule override',
  USER_RISK_RETENTION_DAYS: 'data retention window',
  USER_RISK_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  USER_RISK_SCAN_CRON: 'job schedule override',
  USER_RISK_TRAINING_DEDUP_HOURS: 'timing knob',
  USER_RISK_WORKER_CONCURRENCY: 'worker throughput knob',
  // VIEWER_*
  VIEWER_BINARY_DIR: 'filesystem path',
  // WINGET_*
  WINGET_BOOTSTRAP_ARTIFACT_DIR: 'filesystem path',
  // WIN_*
  WIN_TEST_VM_SSH_KEY: 'AI patch-test lab VM',
  WIN_TEST_VM_TARGET: 'AI patch-test lab VM',
  // WORKSPACE_*
  WORKSPACE_CONTENT_LLM_MODEL: 'model override',
  // WS_*
  WS_TICKETS_REQUIRE_REDIS: 'remote access strictness flag',
  WS_TICKET_BIND_IP: 'remote access ticket binding flag',
};
```

- [ ] **Step 4: Run the ratchet and confirm green**

Run: `cd apps/api && npx vitest run src/system/connections/envInventory.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Mutation check (proves unclassified + stale both bite)**

Temporarily replace the line `  LOG_LEVEL: 'logging verbosity',` with `  NOT_A_REAL_VAR: 'x x x x',`. Run: FAIL with two tests — unclassified `["LOG_LEVEL"]` and stale `["NOT_A_REAL_VAR"]`. Revert; PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/system/connections/internalEnvVars.ts apps/api/src/system/connections/envInventory.test.ts
git commit -m "test(api): env coverage ratchet for the System page (invariant 1)

Scans apps/api/src with five read shapes plus ENV_SCHEMA_KEYS and builtin
enableEnvVar; every name must be in the registry or INTERNAL_ENV_VARS,
with stale and duplicate checks.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `buildConnectionsReport` with canary and value-shape guards (invariants 2, 4)

**Files:**
- Create: `apps/api/src/system/connections/report.ts`
- Test: `apps/api/src/system/connections/report.test.ts`

**Interfaces:**
- Consumes: `CONNECTION_REGISTRY` (Task 4); `isSet`, `isFlagOn` (Task 2); `CONNECTION_GROUPS`, `CONNECTION_STATUSES` and report types (Task 2).
- Produces: `buildConnectionsReport(env: EnvSnapshot, registry?: readonly ConnectionEntry[]): ConnectionsReport` and `displayableValue(raw: string | undefined): string | undefined`. Task 7's route calls `buildConnectionsReport(process.env)`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/system/connections/report.test.ts`:

```ts
/**
 * buildConnectionsReport + invariants 2 (secret canary, value-shape guard)
 * and 4 (reasons name vars, never values — reasons are part of the
 * serialized report the canary scans).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONNECTION_REGISTRY } from './registry';
import { buildConnectionsReport, displayableValue } from './report';
import { CONNECTION_GROUPS, type ConnectionsReport } from './types';

const secretVars = CONNECTION_REGISTRY.flatMap((e) => e.vars).filter((v) => v.secret !== false).map((v) => v.name);
const publicVars = CONNECTION_REGISTRY.flatMap((e) => e.vars).filter((v) => v.secret === false).map((v) => v.name);

/** Realistic non-secret values, chosen by name shape. */
function realisticValue(name: string): string {
  if (/_ENABLED$|^ENABLE_|_ENFORCED$|ALLOW_|TRUSTS_MFA$|^FORCE_HTTPS$|^TRUST_|INCLUDE_DEFAULT|_SECURE$/.test(name)) return 'true';
  if (/_PORT$/.test(name)) return '5349';
  if (/_URL$|_URI$|ENDPOINT|_ORIGIN$|^OAUTH_ISSUER$|^BREEZE_SERVER$|_ORIGINS$/.test(name)) return 'https://svc.example.test';
  if (/_ORG_IDS$|_USER_IDS$/.test(name)) return '11111111-1111-4111-8111-111111111111';
  if (/_CLIENT_ID$|_APP_ID$/.test(name)) return '22222222-2222-4222-8222-222222222222';
  if (/_FROM$|_EMAIL$|_ADDRESS$/.test(name)) return 'noreply@example.test';
  if (/_RATE$|MULTIPLIER$|_USD$/.test(name)) return '0.1';
  return 'example-value';
}

function canaryFor(name: string): string {
  return `CANARY_${name}_${randomUUID()}`;
}

/** Every secret var (and its NAME_FILE twin) gets a unique canary. */
function canaryEnv(style: 'bare' | 'embedded'): { env: Record<string, string>; canaries: string[] } {
  const env: Record<string, string> = {};
  const canaries: string[] = [];
  for (const name of secretVars) {
    const canary = canaryFor(name);
    const fileCanary = canaryFor(`${name}_FILE`);
    canaries.push(canary, fileCanary);
    env[name] = style === 'bare' ? canary : `postgresql://user:${canary}@db.example.test:5432/breeze`;
    env[`${name}_FILE`] = `/run/secrets/${fileCanary}`;
  }
  return { env, canaries };
}

function expectNoCanary(serialized: string, canaries: readonly string[]): void {
  const leaked = canaries.filter((c) => serialized.includes(c));
  expect(leaked).toEqual([]);
}

function allReportVars(report: ConnectionsReport) {
  return report.groups.flatMap((g) => g.entries.flatMap((e) => e.vars));
}

describe('buildConnectionsReport', () => {
  it('returns the spec §2 shape: every registry entry once, groups in CONNECTION_GROUPS order', () => {
    const report = buildConnectionsReport({ APP_VERSION: '0.116.0', IS_HOSTED: 'true' });
    expect(report.version).toBe('0.116.0');
    expect(report.deployMode).toBe('hosted');
    expect(report.scope).toBe('api');
    expect(report.groups.map((g) => g.group)).toEqual(CONNECTION_GROUPS.filter((g) => report.groups.some((x) => x.group === g)));
    const ids = report.groups.flatMap((g) => g.entries.map((e) => e.id));
    expect(ids.sort()).toEqual(CONNECTION_REGISTRY.map((e) => e.id).sort());
    const total = Object.values(report.summary).reduce((a, b) => a + b, 0);
    expect(total).toBe(CONNECTION_REGISTRY.length);
  });

  it('defaults version and deployMode from an empty env', () => {
    const report = buildConnectionsReport({});
    expect(report.version).toBe('unknown');
    expect(report.deployMode).toBe('self_host');
    expect(report.summary.required_missing).toBeGreaterThan(0); // database, redis, public URLs, email, keys
  });

  it('shows non-secret values and never a value for a secret var', () => {
    const env = Object.fromEntries(publicVars.map((name) => [name, realisticValue(name)]));
    const report = buildConnectionsReport(env);
    for (const v of allReportVars(report)) {
      if (v.secret) {
        expect('value' in v, v.name).toBe(false);
      } else {
        expect(v.value, v.name).toBe(realisticValue(v.name));
      }
    }
  });
});

describe('invariant 2: secret canary', () => {
  it.each(['bare', 'embedded'] as const)('no %s canary reaches the serialized report (public vars set too)', (style) => {
    const { env, canaries } = canaryEnv(style);
    for (const name of publicVars) env[name] = realisticValue(name);
    expectNoCanary(JSON.stringify(buildConnectionsReport(env)), canaries);
  });

  it('no canary reaches the report when only secrets are set (drives misconfigured reasons)', () => {
    const { env, canaries } = canaryEnv('bare');
    expectNoCanary(JSON.stringify(buildConnectionsReport(env)), canaries);
  });

  it('no canary reaches the report when every flag is on (drives flag-entry reasons)', () => {
    const { env, canaries } = canaryEnv('bare');
    for (const name of publicVars) env[name] = /_ENABLED$|^ENABLE_/.test(name) ? 'true' : '';
    expectNoCanary(JSON.stringify(buildConnectionsReport(env)), canaries);
  });
});

describe('invariant 2: value-shape guard', () => {
  it('realistic non-secret values carry no URL userinfo and no private_key JSON', () => {
    const env = Object.fromEntries(publicVars.map((name) => [name, realisticValue(name)]));
    for (const v of allReportVars(buildConnectionsReport(env))) {
      if (v.value === undefined) continue;
      expect(v.value, v.name).not.toMatch(/:\/\/[^/?#\s]*@/);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(v.value);
      } catch {
        parsed = null;
      }
      expect(JSON.stringify(parsed ?? ''), v.name).not.toContain('private_key');
    }
  });

  it('refuses (renders set, no value) any non-secret value with URL userinfo', () => {
    const canaries: string[] = [];
    const env: Record<string, string> = {};
    for (const name of publicVars) {
      const canary = canaryFor(name);
      canaries.push(canary);
      env[name] = `https://operator:${canary}@host.example.test/path`;
    }
    const report = buildConnectionsReport(env);
    for (const v of allReportVars(report).filter((x) => !x.secret)) {
      expect(v.set, v.name).toBe(true);
      expect('value' in v, v.name).toBe(false);
    }
    expectNoCanary(JSON.stringify(report), canaries);
  });

  it('refuses a non-secret URL value that carries a query string (keys ride in queries)', () => {
    const canary = canaryFor('QUERY');
    expect(displayableValue(`https://gateway.example.test/v1?key=${canary}`)).toBeUndefined();
    expect(displayableValue('https://gateway.example.test/v1')).toBe('https://gateway.example.test/v1');
  });

  it('refuses a non-secret value that carries service-account JSON or PEM key material', () => {
    const canary = canaryFor('JSON');
    expect(displayableValue(JSON.stringify({ type: 'service_account', private_key: canary }))).toBeUndefined();
    expect(displayableValue(`-----BEGIN PRIVATE KEY-----\n${canary}\n-----END PRIVATE KEY-----`)).toBeUndefined();
    expect(displayableValue('redis')).toBe('redis');
    expect(displayableValue('   ')).toBeUndefined();
  });

  it('never throws on hostile values', () => {
    const env = Object.fromEntries(
      [...secretVars, ...publicVars].map((name, i) => [name, ['%%%', '://@', '\u0000', 'postgres://a,b@', ' '][i % 5]!]),
    );
    expect(() => buildConnectionsReport(env)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/system/connections/report.test.ts`
Expected: FAIL — cannot load `./report`.

- [ ] **Step 3: Implement**

Create `apps/api/src/system/connections/report.ts`:

```ts
import { CONNECTION_REGISTRY } from './registry';
import { isFlagOn, isSet } from './statusHelpers';
import {
  CONNECTION_GROUPS,
  CONNECTION_STATUSES,
  type ConnectionEntry,
  type ConnectionStatus,
  type ConnectionsReport,
  type ConnectionsReportEntry,
  type ConnectionsReportVar,
  type EnvSnapshot,
} from './types';

/** `scheme://user:pass@host` — URL userinfo (spec invariant 2, value-shape guard). */
const URL_USERINFO = /:\/\/[^/?#\s]*@/;
/** `scheme://host/path?query` — gateways and DSNs carry keys in the query (cf. CSP_REPORT_URI). */
const URL_QUERY = /^[a-z][a-z0-9+.-]*:\/\/[^?#\s]*\?/i;
/** Service-account JSON or PEM key material pasted into a non-secret var. */
const KEY_MATERIAL = /private_key|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

/**
 * Returns the value to display for a `secret: false` var, or undefined when
 * the value must not be shown. A refused value still renders as `set`.
 */
export function displayableValue(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (URL_USERINFO.test(value) || URL_QUERY.test(value) || KEY_MATERIAL.test(value)) return undefined;
  return value;
}

function reportVar(env: EnvSnapshot, v: ConnectionEntry['vars'][number]): ConnectionsReportVar {
  const set = isSet(env, v.name);
  if (v.secret !== false) return { name: v.name, secret: true, set };
  const value = displayableValue(env[v.name]);
  return value === undefined ? { name: v.name, secret: false, set } : { name: v.name, secret: false, set, value };
}

function reportEntry(env: EnvSnapshot, entry: ConnectionEntry): ConnectionsReportEntry {
  const { status, reason } = entry.status(env);
  return {
    id: entry.id,
    label: entry.label,
    ...(entry.docsUrl ? { docsUrl: entry.docsUrl } : {}),
    status,
    ...(reason ? { reason } : {}),
    vars: entry.vars.map((v) => reportVar(env, v)),
  };
}

/**
 * Pure: env snapshot in, report out. The only place that reads env values for
 * display; it never logs them (spec §2). No DB, no network, no file reads.
 */
export function buildConnectionsReport(
  env: EnvSnapshot,
  registry: readonly ConnectionEntry[] = CONNECTION_REGISTRY,
): ConnectionsReport {
  const summary = Object.fromEntries(CONNECTION_STATUSES.map((s) => [s, 0])) as Record<ConnectionStatus, number>;
  const groups: ConnectionsReport['groups'] = [];

  for (const group of CONNECTION_GROUPS) {
    const entries = registry.filter((e) => e.group === group).map((e) => reportEntry(env, e));
    if (entries.length === 0) continue;
    for (const entry of entries) summary[entry.status] += 1;
    groups.push({ group, entries });
  }

  return {
    version: env.APP_VERSION?.trim() || 'unknown',
    deployMode: isFlagOn(env, 'IS_HOSTED') ? 'hosted' : 'self_host',
    scope: 'api',
    summary,
    groups,
  };
}
```

- [ ] **Step 4: Run the test and confirm green**

Run: `cd apps/api && npx vitest run src/system/connections/report.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Mutation checks (prove the canary and the guard discriminate)**

(a) In `reportVar`, temporarily change `if (v.secret !== false) return { name: v.name, secret: true, set };` to `if (v.secret !== false) return { name: v.name, secret: true, set, value: env[v.name] };`. Run: the four canary tests and `shows non-secret values and never a value for a secret var` FAIL. Revert.
(b) Temporarily change the refusal line to `if (KEY_MATERIAL.test(value)) return undefined;`. Run: `refuses (renders set, no value) any non-secret value with URL userinfo` and the query-string test FAIL. Revert. Re-run: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/system/connections/report.ts apps/api/src/system/connections/report.test.ts
git commit -m "feat(api): buildConnectionsReport with secret canary and value-shape guard

Pure env -> report. Secret vars render set/not set only; non-secret
values with URL userinfo, a URL query or key material are refused.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `GET /api/v1/admin/system/connections` (invariant 6) + final verification

**Files:**
- Create: `apps/api/src/routes/admin/systemConnections.ts`
- Modify: `apps/api/src/routes/admin/index.ts:13` (import) and end of file (mount, after line 45)
- Test: `apps/api/src/routes/admin/systemConnections.test.ts`

**Interfaces:**
- Consumes: `buildConnectionsReport` (Task 6); `CONNECTION_REGISTRY` (Task 4, test only); `adminRoutes` + `platformAdminMiddleware` (`apps/api/src/routes/admin/index.ts:15-17`, `apps/api/src/middleware/platformAdmin.ts:13-55`). The gate's audit action is `platform_admin.system.connections` (`buildRouteAction`, `platformAdmin.ts:57-68`), details `{ method, path }` only (`:31-34`).
- Produces: `systemConnectionsAdminRoutes: Hono` and the HTTP contract `GET /api/v1/admin/system/connections → 200 { data: ConnectionsReport }`, `Cache-Control: no-store`. W02 consumes this.

Test auth mocking mirrors `apps/api/src/routes/admin/aiToolUsage.test.ts:15-31` and PR #6744's `apps/api/src/routes/admin/deprecations.test.ts` (real `adminRoutes` and `platformAdminMiddleware`; `authMiddleware` stubbed to 401 when no auth is set; audit + client-IP services mocked).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/admin/systemConnections.test.ts`:

```ts
/**
 * GET /api/v1/admin/system/connections — invariant 6 (access) and the HTTP
 * half of invariant 2 (secret canary through the real route + gate).
 * Auth mocking mirrors routes/admin/deprecations.test.ts (#6744) and
 * aiToolUsage.test.ts: the real adminRoutes + platformAdminMiddleware, with
 * authMiddleware stubbed to 401 when no auth is set.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
  createAuditLogAsync: auditMock,
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth');
  const { HTTPException } = await import('hono/http-exception');
  return {
    ...actual,
    authMiddleware: vi.fn(async (c: any, next: () => Promise<void>) => {
      if (!c.get('auth')) throw new HTTPException(401, { message: 'Not authenticated' });
      await next();
    }),
  };
});

import { Hono } from 'hono';
import { adminRoutes } from './index';
import { CONNECTION_REGISTRY } from '../../system/connections/registry';

type FakeAuth = {
  scope: 'system' | 'partner' | 'organization';
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  token: { mfa: boolean };
};

const platformAdmin: FakeAuth = {
  scope: 'partner',
  user: { id: 'admin-1', email: 'admin@breeze.test', name: 'PA', isPlatformAdmin: true },
  token: { mfa: true },
};
const partnerAdmin: FakeAuth = {
  scope: 'partner',
  user: { id: 'pa-1', email: 'partner@x.com', name: 'Partner', isPlatformAdmin: false },
  token: { mfa: true },
};
const orgUser: FakeAuth = {
  scope: 'organization',
  user: { id: 'ou-1', email: 'org@x.com', name: 'Org', isPlatformAdmin: false },
  token: { mfa: true },
};

function buildApp(auth: FakeAuth | null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth as never);
    await next();
  });
  app.route('/admin', adminRoutes);
  return app;
}

const PATH = '/admin/system/connections';
const touchedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string): void {
  if (!touchedEnv.has(name)) touchedEnv.set(name, process.env[name]);
  process.env[name] = value;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const [name, original] of touchedEnv) {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  touchedEnv.clear();
});

describe('GET /admin/system/connections — access (invariant 6)', () => {
  it('401 without an authenticated session', async () => {
    expect((await buildApp(null).request(PATH)).status).toBe(401);
  });

  it('403 for a partner admin who is not a platform admin', async () => {
    expect((await buildApp(partnerAdmin).request(PATH)).status).toBe(403);
  });

  it('403 for an organization user', async () => {
    expect((await buildApp(orgUser).request(PATH)).status).toBe(403);
  });

  it('200 for a platform admin, with Cache-Control: no-store and the { data } wrapper', async () => {
    const res = await buildApp(platformAdmin).request(PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.data.scope).toBe('api');
    expect(body.data.groups.length).toBeGreaterThan(0);
  });

  it('exposes GET only — POST, PUT, PATCH and DELETE are 404', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await buildApp(platformAdmin).request(PATH, { method });
      expect(res.status, method).toBe(404);
    }
  });

  it('the gate audit row records method and path only', async () => {
    await buildApp(platformAdmin).request(PATH);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform_admin.system.connections',
        details: { method: 'GET', path: PATH },
      }),
    );
  });
});

describe('GET /admin/system/connections — secret canary over HTTP (invariant 2)', () => {
  it('no secret value appears in the HTTP body', async () => {
    const canaries: string[] = [];
    for (const entry of CONNECTION_REGISTRY) {
      for (const v of entry.vars) {
        if (v.secret === false) continue;
        const canary = `CANARY_${v.name}_${randomUUID()}`;
        canaries.push(canary);
        setEnv(v.name, canary);
      }
    }
    const res = await buildApp(platformAdmin).request(PATH);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(canaries.filter((c) => text.includes(c))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/routes/admin/systemConnections.test.ts`
Expected: FAIL, 2 tests — `200 for a platform admin …` and `no secret value appears in the HTTP body` both get 404 (nothing mounted). The other 5 pass already because `platformAdminMiddleware` gates and audits every `/admin/*` path, mounted or not; they pin the gate's behaviour for this path.

- [ ] **Step 3: Write the router**

Create `apps/api/src/routes/admin/systemConnections.ts`:

```ts
/**
 * System → Connections report (spec: docs/superpowers/specs/platform-ci/
 * 2026-09-23-system-connections-page-design.md §3).
 *
 *   GET /api/v1/admin/system/connections   { data: ConnectionsReport }
 *
 * Platform-admin only because it is mounted under `adminRoutes`, whose
 * platformAdminMiddleware gates every request (the gate's audit row records
 * method + path only). Read-only: GET is the only verb; others 404. No DB
 * access, so it cannot hang or fail on database state. Values of secret vars
 * never leave buildConnectionsReport.
 */
import { Hono } from 'hono';
import { buildConnectionsReport } from '../../system/connections/report';

export const systemConnectionsAdminRoutes = new Hono();

systemConnectionsAdminRoutes.get('/connections', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ data: buildConnectionsReport(process.env) });
});
```

- [ ] **Step 4: Mount it under the platform-admin gate**

In `apps/api/src/routes/admin/index.ts`, add after line 13 (`import { adminSendingDomainsRoutes } from './sendingDomains';`):

```ts
import { systemConnectionsAdminRoutes } from './systemConnections';
```

and append at the end of the file (after `adminRoutes.route('/sending-domains', adminSendingDomainsRoutes);`):

```ts
// System page W01: read-only connection status (which integrations this
// deployment has configured). Deployment-wide, so platform-admin only via the
// gate above; GET only. Never mount this as api.route('/admin/...') in
// src/index.ts — that would sit outside platformAdminMiddleware.
adminRoutes.route('/system', systemConnectionsAdminRoutes);
```

(If #6744 has merged first, its `adminRoutes.route('/deprecations', …)` line is already the last line; add this block after it.)

- [ ] **Step 5: Run the route test and confirm green**

Run: `cd apps/api && npx vitest run src/routes/admin/systemConnections.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run every touched suite plus the neighbours that import `adminRoutes`**

Run:
```bash
cd apps/api && npx vitest run src/system/connections/ src/routes/admin/ src/routes/system.test.ts
```
Expected: PASS. (`src/routes/admin/` includes the existing admin suites, which import the same `adminRoutes` index and must stay green.)

- [ ] **Step 7: Typecheck (read the exit code; never pipe tsc)**

Run:
```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit=$?"
```
Expected: `tsc exit=0`. Any non-zero exit (including a heap OOM) is a failure — do not proceed.

- [ ] **Step 8: Confirm nothing outside the gate serves the report**

Run: `grep -n "systemConnections\|/admin/system" apps/api/src/index.ts`
Expected: no output (the only mount is `adminRoutes.route('/system', …)`).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/admin/systemConnections.ts apps/api/src/routes/admin/systemConnections.test.ts apps/api/src/routes/admin/index.ts
git commit -m "feat(api): GET /admin/system/connections for the System page (W01)

Platform-admin only via adminRoutes; GET only, Cache-Control no-store,
{ data: ConnectionsReport }. Access (invariant 6) and HTTP secret canary
tests.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Self-review against the spec

| Spec item | Where |
|---|---|
| D1 read-only | Task 7 router (GET only) + `exposes GET only` test |
| D2 secrets never shown | Task 6 `reportVar` (no `value` key for secrets) + canary tests (Task 6, Task 7) |
| D3 curated registry | Task 4 |
| D4 config only | Task 6 builder is pure; Task 7 route has no DB/network |
| D5 API env only | `scope: 'api'` (Task 6) |
| D6 platform admins, via `adminRoutes` | Task 7 mount + access tests + Step 8 grep |
| D7 home `/admin/system` | W02 (web); W01 serves `/api/v1/admin/system/connections` |
| D8 default-deny | `reportVar`: `v.secret !== false` ⇒ secret (Task 6) |
| D9 delete `/system/config-status` | Task 1 |
| D10 resolver-mirroring status | Task 3 |
| D11 `_FILE` | `isSet` (Task 2); Redis compose test with a nonexistent `REDIS_PASSWORD_FILE` path (Task 3) |
| §1 registry type, default status helper, groups, `INTERNAL_ENV_VARS` | Tasks 2, 4, 5 |
| §2 report shape; builder is the only value reader, never logs | Task 6 |
| §3 route, `Cache-Control: no-store`, audit is method+path | Task 7 |
| Invariant 1 ratchet (+ stale, duplicates, ENV_SCHEMA_KEYS, builtin enableEnvVar, `__tests__` excluded) | Task 5 |
| Invariant 2 canary (builder + HTTP) + value-shape guard (fixture + runtime refusal) | Tasks 6, 7 |
| Invariant 3 secret-name guard + exceptions | Task 4 |
| Invariant 4 reasons never carry values | Task 6 canary covers serialized reasons in three env shapes |
| Invariant 5 truthfulness per core entry | Task 3 |
| Invariant 6 access (401/403/403/200/404×4) | Task 7 |
| `docsUrl` existence test | Task 4 |
| Group ids aligned with W02 | Task 2 `CONNECTION_GROUPS` |
