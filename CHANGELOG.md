# Changelog

All notable changes to Breeze RMM will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
