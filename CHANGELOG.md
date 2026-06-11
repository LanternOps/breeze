# Changelog

All notable changes to Breeze RMM will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.67.1] - 2026-05-26

### Critical for v0.67.0 self-hosters
- v0.67.0 shipped Windows binaries with no embedded VERSIONINFO resource because the existing CI step ran `go-winres make --in winres.json` against a malformed JSON schema and never checked `$LASTEXITCODE`. The MSI's default file-replacement rule then refused to overwrite an existing `breeze-agent.exe` in many real-world upgrade scenarios ("Won't Overwrite; existing file is unversioned but modified"). v0.67.1 switches to `go-winres simply` (CLI args, gated on exit code), embeds correct `FileVersion` / `ProductVersion` resources on all four Windows binaries, and broadens the MSI `KillBreezeProcesses` custom-action condition from `WIX_UPGRADE_DETECTED OR Installed` to `NOT REMOVE` so the agent process is freed for replacement on every install path. Verify with `Get-Item 'C:\Program Files\Breeze\breeze-agent.exe' | Select-Object -ExpandProperty VersionInfo` (#944, #949).

### Added
- `POST /devices/:id/move-org` — admin endpoint for cross-organization device relocation. Writes a dual-axis audit trail (`device.move_org.source` in the source org's audit feed and `device.move_org.target` in the destination). Atomically rewrites the denormalized `org_id` column on every device-scoped child table inside one transaction (#875).
- `POST /devices/provision` — admin endpoint to pre-create device rows with `status='pending'` ahead of agent enrollment. Pairs with `move-org` so the workflow becomes: admin provisions into a staging org → ships config → agent enrolls → admin relocates to the customer org (#902).
- Sidebar version-staleness indicator. The footer's API version colors red when behind the latest GitHub release, green when current. Tooltip names the latest version. Falls back to muted color when GitHub is unreachable so air-gapped installs aren't permanently marked red. The API exposes `latest`, `isStale`, `latestFetchedAt`, `latestSource` on `GET /system/version` (#903).
- Agent in-process supervision of BreezeWatchdog (Layer A4). The main agent now restarts a stopped watchdog the same way the watchdog restarts the main agent (#854, #860).
- Agent management-state detection falls back to the registry when `dsregcmd /status` fails. Domain Controllers return non-zero from dsregcmd in many configurations and were previously misclassified (#895).
- SCM service-recovery actions on MSI deploys. `sc qfailure BreezeAgent` after install now reports 5s/10s/30s restart escalation with an 86400s (24h) reset window. Complements the v0.67.0 watchdog auto-restart (which handles the wedge case) by covering the crash-hard case (#853).

### Fixed
- Enrollment keys are no longer burned by failed enrollments. The `enrollment_keys.usage_count` increment used to live in a standalone pre-INSERT UPDATE; any post-validation failure (hostname collision, device-limit, etc.) consumed a single-use key without ever creating a device. The increment is now the last statement inside the device-INSERT transaction so failure paths roll back atomically. TOCTOU race semantics for concurrent claims are preserved by re-applying the validity conditions in the in-tx UPDATE (#946, #948).
- `POST /enrollment-keys` rejects unknown fields. A misspelled `maxUses` (canonical: `maxUsage`) used to silently fall through to the default of 1. All four write schemas (`createEnrollmentKeySchema`, `rotateEnrollmentKeySchema`, `installerLinkSchema`, `bootstrapTokenBodySchema`) now use `.strict()` so unknown keys surface as a 400 with the offending key in the body (#945, #947).
- Re-enrollment on a hostname whose previous row is decommissioned now mints a fresh `device.id` instead of inheriting the old row's attribution. The old row is renamed in-transaction to `<hostname>.decom-<short-id>` to free the hostname slot; FK-attached history (alerts, agent_logs, hardware) stays with the old row for forensic continuity (#914, #924).
- Re-enrollment without a prior device token is now permitted when the existing row is in `decommissioned` status. Previously returned `401 hostname_collision_requires_existing_device_token` even on the legitimate replacement path (#896).

### Security
- 45-commit launch-readiness hardening sweep. Site-scoped RBAC enforcement with drift detection, audit-trail integrity, OAuth client soft-revocation on self-reported suspicious approval (closes ~15-minute access-token window), and an additional code-scanning bounds-check + dep-bump pass (#864, #868, #872, #900, #904).
- SSRF allowlists on outbound integration URLs. DNS providers (Umbrella, Cloudflare, DNSFilter get strict-HTTPS + vendor-suffix allowlist; Pi-hole, AdGuard Home get on-prem-HTTP with loopback/link-local still blocked). SentinelOne `managementUrl` constrained to `.sentinelone.net`. Admin `suspend-for-abuse` and `tenant-erasure` require MFA plus an anti-typo email confirmation. `/devices/provision` `canAccessOrg` check now fails closed instead of defensively skipping (#910, #911, #913, #917, #918).
- Audit-log sanitizer + global Sentry capture + sync-job redaction. Audit `details` JSON no longer contains raw tokens, passwords, or PII; Sentry breadcrumbs filter the same fields; background sync jobs (DNS sync, S1 sync) redact integration credentials from error reports (#923).
- Authenticated Redis required in production. The API refuses to boot in `NODE_ENV=production` without `REDIS_PASSWORD` set. Boot-time check, fast-fail with a clear error (#909).
- Docker base images pinned to Node 24 LTS for api/web (#908).
- Legacy `mcp:write → ai:execute` back-compat scope expansion removed (deprecation window closed 2026-05-15). MCP clients must request `ai:execute` explicitly (#870).

## [0.67.0] - 2026-05-23

### Added
- **Asymmetric main-agent silence detection (server slice).** When the main agent goes silent but the watchdog continues to heartbeat (the "wedge" case — process alive but stuck), the server flips `watchdog_status='failover'` and stamps `main_agent_silent_since`. A new amber "Agent silent (watchdog OK)" badge is designed to surface this on the Devices list. NOTE: the list-endpoint response mapper dropped both fields in v0.67.0 so the badge does not render end-to-end without the v0.67.1+ fix (PR #940) (#799, #800, #851, #861, #862).
- **Watchdog auto-restart on prolonged heartbeat silence.** Standalone-watchdog state machine adds a `Failover` state reached after `StandbyTimeout` (default 30min) of main-agent silence. Restarts main up to `MaxRestartsPer24h` (default 5) before the watchdog takes over HTTP heartbeating directly. Defense-in-depth against silent wedges that systemd/SCM service-restart can't see (#852).
- **In-place agent upgrade now deploys breeze-user-helper.exe.** The user-helper binary (GUI-subsystem Windows process for per-session work like notifications and clipboard) was previously not included in the upgrade payload, leaving upgrades with a missing helper. The auto-updater now threads companion binaries through `UpdateOptions` so any auxiliary binary registered alongside the agent ships in lockstep (#816, #845, #848, #849, #850).
- **Keyset cursor pagination on GET /devices.** Server returns a base64-encoded cursor for `(hostname, id)` keyset; web Devices page consumes it for stable pagination through large fleets. Offset mode kept for backwards compatibility (#742, #777, #778).
- **On-demand inventory refresh command + UI button.** New per-device "Refresh Inventory" action triggers an out-of-band hardware/software/network collection cycle without waiting for the scheduled sweep. Bulk endpoint dedups concurrent requests; second `refresh_inventory` while the first is queued returns 409 (#788, #830, #856, #863).
- **Smart wake toast.** Wake-on-LAN initiation now spawns a toast that actively polls device status instead of asking the operator to "wait 5 minutes" (#789).
- **Per-channel notification throttle.** Sliding-window cap on notifications-per-channel-per-window prevents alert storms; per-channel UI surface in Settings → Notifications. Atomic Redis multi() chain prevents racing claims at the cap (#796).
- **Severity-by-exit-code mapping for scripts.** Server-side schema lets scripts map exit codes to alert severities (`critical`/`high`/`medium`/`low`/`info`). API-only in v0.67.0; UI editor in the new-script form follows in PR #941 (#798).
- **DNS Security: AdGuard Home provider** (#797). DNS Security web UI scaffold — sidebar entry, `/dns-security` page with Overview/Integrations/Policies/Events tabs, AdGuard Home appears in the Add Integration dialog alongside Umbrella, Cloudflare Gateway, DNSFilter, and Pi-hole (#847). Alerts raised on `dns.threat.blocked` events with per-(device, category) cooldown (#843, #846).
- **Exhaustive multi-vendor SNMP template library.** Built-in templates for Ubiquiti UniFi (3 templates), Cisco, Dell, Fortinet, SonicWall, MikroTik, Aruba, Synology, QNAP, APC/Eaton/CyberPower UPS, Juniper, HPE, Lenovo, Netgear, TP-Link, Brother, Lexmark, Meraki, CommScope, plus 3 generic RFC templates — 31 templates across 23 vendor groups, all built-in and org-readable (#826, #836, #844).
- **Audit-log UX overhaul.** Humanized action codes (`device.update` → "Updated device"), agent-actor resolution to device hostname ("Agent (WIN-FILESERVER-02)" instead of bare "Agent"), modal layout fix for long detail payloads, and viewer performance improvements (#794, #803, #841).
- **Permission catalog endpoint + Roles UI consumption.** `GET /permissions/catalog` returns the full permission inventory (34 permissions, 12 resource groups, action labels); RolesPage permission-matrix renders from the catalog. Clone-role UX surfaces inline errors via `runAction` (wildcard rejection, missing permissions, etc.); RoleManager toggleExpand surfaces `/roles/:id` errors instead of leaving the matrix blank on a server error (#801, #802, #839, #840).
- **Frame-src CSP directive for docs iframe** (#834).

### Improved
- **Audit-log query performance.** Dashboard widget calls now bypass `count(*)` when `skipCount=true` (sentinel `total: -1, totalPages: -1` in the response). LATERAL per-org index scan replaces the previous join shape when both `skipCount` and no filters are in play (#791, #792).
- **Wake-on-LAN subnet candidate iteration.** WoL service now tries every subnet candidate on the relay agent's interfaces (skipping APIPA addresses) instead of just the first; finds real-LAN candidates correctly on multi-homed hosts (#784).
- **Linux firewall detection** allows the ufw lockfile + parses output on non-zero exit, so `ufw status` running under contention no longer marks the firewall posture as "unknown" (#751).
- **Heartbeat MAC-address acceptance** raised from typical interface-name length to 64 chars to cover pseudo-interface MACs on Hyper-V/WSL2 hosts (#790).
- **Devices row kebab dropdown flips upward** when the row is near the viewport bottom so the menu isn't clipped (#786).
- **`submitChangesSchema.max`** raised from a hard-coded 1000 to a configurable default of 50000 — fleets with large per-device changesets no longer hit the 400 (#752).

### Fixed
- **`orgId` query parameter accepted on multi-org write endpoints** that previously only accepted body-level org: sensitive-data scans (#806/#810), software-policies POST (#808/#813), patches approvals (#805/#814). Date fields in the same payloads now serialize as ISO strings for sql-tag binding (#825).
- **Event-bus runs publish outside any active DB transaction context.** A handler enqueued from inside a route transaction used to inherit the transaction's snapshot isolation and could observe stale state. Now decoupled (#815, #842).
- **DNS provider sync serializes domain mutations** instead of racing concurrent PATCHes — fixes rule clobbering on the Umbrella/DNSFilter sync paths (#827, #833).
- **Sensitive Data FindingsTab select-all** now scopes to filtered rows instead of the full table (#809, #819).
- **Audit-log agent-actor user column** no longer leaks the device hostname into the user column — properly qualified to the user table join (#841).
- **Migration backport** to fix 0040 `target_type DROP NOT NULL` on fresh installs that skip the older incremental path (#807, #812).

### Security
- **`golang.org/x/net` v0.55.0** for GO-2026-5026 (#837).
- **`js-cookie` ≥3.0.7** for CVE-2026-46625 (#824).
- **Scale-readiness pack** (Phase 1 jobs + Phase 2 indexes) plus an RLS-policy bug fix surfaced during the index pass (#753).

## [0.66.1] - 2026-05-19

### Fixed
- Desktop viewer/installer Tauri apps failed to mount on the React 19 build that v0.66.0 shipped. `useRef(undefined)` is now an explicit `undefined` argument to satisfy React 19's type narrowing (#785).

## [0.66.0] - 2026-05-18

### Added
- **Bulk Wake-on-LAN.** Select multiple offline devices on the Devices page and wake them in one click via the bulk-actions menu. Each wake routes through a still-online device on the same network; per-device result is surfaced in the bulk-action toast (#682, #694, #782).

### Fixed
- **Discovery `:id` handlers honor `orgId` query parameter** for multi-org partners who weren't getting the org-scope routing on the per-scan-id paths (#779).

### Security
- **Security-report SR-001..SR-009 hardening pass.** Closes the public-exploitability findings from the customer-launch security review: tenant-isolation gaps on internal tools routes, action-payload sanitization, MFA gating coverage, and a handful of related cross-cutting issues. SR-003 was determined to be by-design and skipped; SR-006 remains tracked for a later release (#568, #781).

## [Unreleased - pre-0.66 / v0.65.x retroactive]

### Fixed
- **Public registration silently disabled on all v0.65.x web images.** PR #568
  flipped the `PUBLIC_ENABLE_REGISTRATION` source default from `true` to `false`
  without a rollout mitigation. Because Vite/Astro bakes `import.meta.env.PUBLIC_*`
  values into the bundle at build time, and `apps/web/Dockerfile` defaulted the
  build ARG to `false`, every v0.65.x web image hardcoded
  `PUBLIC_ENABLE_REGISTRATION=false` — `/register` redirected to
  `/login?reason=registration-disabled` with no env-var override possible. Hosted
  SaaS signups have been dead since v0.65.0. Fix: source default reverted to
  `true`, Dockerfile ARG default reverted to `true`, and `release.yml` now
  explicitly passes `PUBLIC_ENABLE_REGISTRATION=true` as a build-arg for
  defense-in-depth.
- **#625 — `BINARY_SOURCE=local` agent updates broken on v0.65.8.** The strict-signing
  enforcement from #568 hard-rejected unsigned manifests on `/agent-versions/:v/download`,
  but the local-binary sync path didn't sign anything. Self-hosted operators using
  `BINARY_SOURCE=local` saw every agent auto-update return 409 with
  `signed_release_manifest_required`, leaving devices stuck in `status='updating'`. Fix:
  the API now generates a per-deployment Ed25519 signing keypair on first boot
  (encrypted with `APP_ENCRYPTION_KEY`, stored in a new `manifest_signing_keys` table)
  and signs every locally-registered manifest. The public key is delivered to agents
  via the enrollment response (new agents) and the heartbeat response (existing agents,
  pinned TOFU-style) so the next manifest verification succeeds.

### Added
- Boot-time manifest signing self-test for `BINARY_SOURCE=local` deployments. Round-trips
  a synthetic manifest through `signManifest` → `validateReleaseManifest` and aborts
  startup if either side disagrees. Catches misconfigurations during `docker compose up`
  rather than after the fleet is stuck.
- CI smoke test job (`smoke-binary-source-local`) that boots the API in
  `BINARY_SOURCE=local` mode against a fake binary and asserts the download endpoint
  returns 200 with non-null manifest fields. Triggered by changes to `binarySync`,
  `manifestSigning`, `agentVersions`, or migrations.
- `recover-stuck-agents` script extended to v0.65.7 and v0.65.8 — operators on those
  versions can run `pnpm recover:stuck-agents -- --apply` after deploying v0.65.9 to
  unstick fleets that can't auto-update through the strict-signing gate.
- `docs/deploy/agent-update-trust-bootstrap.md` documenting the trust model, recovery
  procedure, and key rotation guidance.
- Cloudflare mTLS client certificate management for agent-to-server mutual TLS authentication
- Device quarantine workflow with admin approval/deny for certificate-based trust
- AI agent migration to Claude Agent SDK with managed query loop
- Per-organization mTLS settings via JSONB configuration

### Changed
- AI brain connector now uses Claude Agent SDK managed query loop instead of manual orchestration

### Security
- Hardened CORS policies with strict origin allowlisting
- Hardened portal session handling and cookie security
- Strengthened MCP endpoint authentication
- Added APP_ENCRYPTION_KEY for field-level encryption at rest
- Improved XSS defenses across the web dashboard
- Added secret scanning configuration for public repository

## [0.1.0] - 2026-02-10

Initial public release of Breeze RMM.

### Added

#### Core Platform
- Multi-tenant hierarchy: Partner (MSP) > Organization > Site > Device Group > Device
- Role-based access control (RBAC) with cascading permissions
- JWT authentication with session management
- API key authentication with SHA-256 hashed secrets
- Redis-backed sliding window rate limiting
- Audit logging for all mutating operations

#### Device Management
- Hardware and software inventory (CPU, memory, storage, network, installed applications)
- Real-time device health checks with configurable thresholds
- Policy engine for defining and enforcing configuration across device groups
- Advanced device filtering across any attribute
- Network discovery with ping sweep and port scanning
- Agent enrollment with secure token exchange

#### Remote Access
- Remote terminal with full PTY support (macOS and Windows)
- Remote file browser with upload and download
- Remote desktop via WebRTC with optimized streaming pipeline
- TURN relay support for NAT traversal

#### Automation
- Remote script execution (PowerShell, Bash, Python) across devices
- Patch management with inventory, approval, and deployment workflows
- Windows patching via winget provider with user helper IPC
- Configurable alerting with severity classification and routing
- BullMQ job queue for asynchronous task processing

#### Agent (Go)
- Cross-platform agent binary (macOS, Windows, Linux)
- Per-interface network bandwidth tracking
- Session broker with SID-based identity and protocol validation (Windows)
- Deep filesystem analysis and disk cleanup preview
- Registry key management commands (Windows)
- Secure config file permissions (0700 dir, 0600 file)
- Agent token authentication with SHA-256 hashed bearer tokens

#### AI Brain (BYOK)
- AI chat assistant on every dashboard page via Claude Agent SDK
- Tool-equipped agent capable of querying devices, running diagnostics, and executing remediations
- Risk-classified action engine (Low/Medium/High/Critical) enforced at the platform level
- Bring-your-own-key support for Anthropic API keys

#### Integrations and Infrastructure
- Docker Compose development environment (PostgreSQL, Redis, MinIO)
- Drizzle ORM with push-based schema migrations
- Prometheus and Grafana monitoring configuration
- SNMP client with discovery, metrics collection, and polling
- File transfer storage via MinIO/S3-compatible backend
- Enrollment key management for streamlined agent onboarding

#### Documentation
- README with quick start, architecture overview, and FAQ
- Contributing guide with development setup instructions
- Security policy with responsible disclosure process
- Agent installation and Windows installer signing guides
- Admin guide with deployment and configuration reference

### Fixed
- Desktop deep link reliability, mouse alignment, and keyboard input for remote desktop
- File manager path traversal hardening and migration runner stability
- Session broker protocol validation and scope enforcement
- Discovery results silently dropped when dispatched via WebSocket without DB record
- PTY support on macOS rewritten with cgo for correct TIOCPTYGNAME behavior
- Terminal race condition resolved by waiting for server connected message before sending data
- URL references updated from lanternops.com to lanternops.io

### Security
- Hardened secret handling with secure-by-default auth flows
- Agent REST routes require bearer token authentication (except enrollment)
- WebSocket agent authentication accepts both header and query parameter tokens
- API security review addressing 39 findings across patching, desktop streaming, and auth
- Dependabot enabled for Go modules, npm packages, and GitHub Actions
