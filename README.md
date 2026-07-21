<p align="center">
  <img src="docs/assets/breeze-logo.png" alt="Breeze" width="120" />
</p>

<h1 align="center">Breeze</h1>

<p align="center">
  <strong>The open-source IT platform that comes with the workers.</strong><br/>
  A full RMM + PSA with an AI team built in. It triages alerts, patches fleets, and resolves tickets. You hold the approvals.
</p>

<p align="center">
  <a href="https://breezermm.com/features/"><strong>▶ Live Demos</strong></a> •
  <a href="#security">Security</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#features">Features</a> •
  <a href="#ai-operator">AI Operator</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#roadmap">Roadmap</a> •
  <a href="#contributing">Contributing</a> •
  <a href="#license">License</a>
</p>

<p align="center">
  <a href="https://github.com/lanternops/breeze/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License" /></a>
  <a href="https://github.com/lanternops/breeze/releases"><img src="https://img.shields.io/github/v/release/lanternops/breeze" alt="Release" /></a>
  <a href="https://breezermm.com/discord"><img src="https://img.shields.io/badge/discord-join-7289da" alt="Discord" /></a>
</p>

<p align="center">
  <img src="docs/assets/breeze-ai-demo.gif" alt="Breeze AI Demo: check a device's health" width="800" />
</p>

<p align="center">
  <em>Want to click around?</em> <a href="https://breezermm.com/features/"><strong>Interactive feature demos at breezermm.com/features</strong></a> (e.g. <a href="https://breezermm.com/features/remote-access/">Remote Access</a>).
</p>

---

## What is Breeze?

Breeze is a full IT platform for MSPs and internal IT: monitoring, patching, remote access, scripting, and network discovery, plus ticketing, quotes, billing, invoicing, and a service catalog in the same system. The AI is built into its core, not bolted on as an afterthought.

Every RMM on the market hands you a dashboard and leaves the labor to you. Breeze hands you a team: **an AI operator that uses the platform for you.** It investigates alerts, remediates issues, resolves tickets, documents what it did, and only interrupts you when it needs a human decision.

Breeze is free, open source (AGPL-3.0), and designed to be self-hosted or [cloud-hosted at breezermm.com](https://breezermm.com) (US and EU regions).

### Why Breeze?

- **AI-native, not AI-added.** Every page has an AI operator that can see what you see and take action using built-in tools. Not a chatbot, an agent.
- **RMM + PSA in one system.** Resolved is nice. Invoiced is better. The ticket, the time entry, the quote, and the invoice live where the work happens. No separate PSA, no sync job.
- **Never metered.** Self-host with unlimited devices, forever. Every module ships in every plan; nothing sits behind a paywall.
- **Lightweight agent.** Single Go binary. Cross-platform. Minimal resource footprint. Your clients won't notice it's there.
- **Actually open source.** AGPL-3.0. Read every line. Fork it. Contribute. No bait-and-switch.
- **Multi-tenant from day one.** Built for MSPs managing multiple clients, not retrofitted from a single-tenant architecture.
- **Modern stack.** Not a legacy codebase with 15 years of technical debt. Clean, fast, extensible.

---

## Security

Breeze has privileged access to every device it manages. We take that seriously.

| Layer | What We Do |
|---|---|
| **Authentication** | Argon2id passwords, JWT with 15-min expiry, TOTP MFA, SHA-256 hashed tokens, email verification on signup |
| **Authorization** | RBAC with scope-based multi-tenancy, forced PostgreSQL row-level security on every tenant table; no app-layer-only fallback, even table owners can't bypass |
| **Encryption** | AES-256-GCM at rest, TLS 1.2+ in transit, HSTS preload, no plaintext secrets stored anywhere |
| **Agent hardening** | Bearer token auth (SHA-256 hashed), 0600 config file permissions, optional Cloudflare mTLS |
| **Rate limiting** | Redis sliding window on all auth endpoints and agent APIs; fail-closed if Redis is unavailable |
| **Input validation** | Zod schemas on every external input: API requests, WebSocket messages, query parameters |
| **AI safety** | Risk-classified action engine. Dangerous operations require human approval; critical operations are blocked entirely |
| **Supply chain** | 5 automated scanners in CI: CodeQL SAST, Gitleaks, npm audit, govulncheck, Trivy CVE scanning |
| **Audit trail** | Structured audit logging with actor tracking, org-scoped retention policies, S3 archival |
| **Operational** | Secret rotation runbooks, disaster recovery procedures (RTO < 1 hour, RPO < 15 minutes) |
| **Abuse controls** | Cross-tenant platform-admin suspend endpoint, email-verification gate on signup, fail-closed token revocation |

For the full security whitepaper, including SOC 2 alignment mapping, see **[Security Practices](docs/security/SECURITY_PRACTICES.md)**.

To report a vulnerability: **[security@lanternops.io](mailto:security@lanternops.io)**. See [SECURITY.md](SECURITY.md) for our disclosure policy.

---

## Features

### Device Management
- **Hardware & software inventory.** CPU, memory, storage, network, installed applications, versions
- **Real-time device health.** Health checks with configurable thresholds and alerting
- **Configuration policies.** Hierarchical policy management with feature links and per-assignment resolution
- **Advanced filtering.** Query your fleet with powerful filters across any device attribute
- **Network discovery.** ARP, ICMP, port, and SNMP scans to find unmanaged devices on each site
- **Custom fields & tags.** Extend device records with your own metadata
- **Configuration drift & change tracking.** Audit baselines, CIS hardening checks, software/peripheral policies

### Remote Access
- **Remote terminal.** Full shell access to managed devices
- **Remote file browser.** Browse, upload, and download files
- **Remote desktop.** Visual remote control of devices, multi-display, clipboard sync, computer-control automation
- **Native viewer & helper apps.** Tauri-based desktop apps for macOS and Windows
- **Activity monitoring.** See what's happening on a device in real time
- **TURN relay.** Built-in coturn for WebRTC traversal across NATs and firewalls

### Automation
- **Remote scripting.** Execute scripts (PowerShell, Bash, Python) across devices
- **Patch management.** Inventory, approve, and deploy OS and application patches; maintenance windows + update rings
- **Alerts & notifications.** Configurable alerts with severity classification, routing, webhook delivery
- **Playbooks.** Reusable remediation workflows
- **Deployments.** Push agents and software at scale
- **Watchdog.** Self-healing agent supervisor that auto-restarts on failure

### Service Desk & Billing (PSA built in)
- **Tickets & help desk.** One queue for every request from alerts, devices, and your customers; SLA tracking, time and parts logged on the ticket as the work happens
- **Quotes.** From ticket to quote without leaving the platform, priced from your catalog with your markups applied
- **Billing & invoicing.** Time and parts on the ticket become the invoice. No export, no re-entry, no second system to reconcile
- **Service catalog.** Price it once. Quote it and bill it everywhere
- **Customer portal.** A branded self-service hub where your clients' end-users open tickets and see their devices and assets

### Backup & Recovery
- **Endpoint snapshot backup.** Restic-based snapshots to S3-compatible storage
- **Bare-metal recovery.** Full-disk restore for Windows endpoints
- **Hyper-V & SQL Server agents.** Application-aware backups
- **Cloud-to-cloud (M365).** Email, OneDrive, SharePoint, Teams, calendar
- **Disaster recovery & verification.** Restore tests, encryption, retention policies

### Integrations
- **EDR.** SentinelOne and Huntress with risk-classified actions and incident correlation
- **MCP server.** The first MCP server shipped in an RMM. Connect Claude.ai, ChatGPT, Cursor, or any MCP-aware AI agent over OAuth 2.1

### AI Operator (included free)
- **AI chat on every page.** Context-aware operator that knows what you're looking at
- **Tool-equipped agent.** The AI doesn't just talk, it acts: querying devices, running diagnostics, executing remediations
- **Risk-classified actions.** Every AI action is validated against a risk engine before execution. Impactful actions require human approval. Always.
- **Bring your own key.** Plug in your Anthropic API key and the operator works out of the box
- **External AI agents via MCP.** Or connect Claude.ai, ChatGPT, Cursor through the built-in MCP server with OAuth 2.1 + PKCE

> **🤖 [Managed AI Ops](https://breezermm.com/brain/):** Want the workers included? A team of AI agents works your queue (triage, patching, tickets) inside your own Breeze instance, while we read the AI's conversations, verify its resolutions, and tune the agents with you. Your risk engine holds the approvals throughout. Available on self-hosted or cloud Breeze. [Book a call →](https://breezermm.com/contact/)

---

## Quick Start

### Option 1: Cloud Hosted (Easiest)

Skip infrastructure entirely. [Sign up at breezermm.com](https://breezermm.com) and have a fully managed Breeze instance in minutes. US and EU regions are live; the cloud is in public beta.

### Option 2: Self-Hosted Guided Setup

Requires [Docker](https://docs.docker.com/get-docker/) and Docker Compose.

Run the guided setup from an empty directory where you want Breeze's generated `.env` and `docker-compose.yml` files to live:

```bash
mkdir breeze && cd breeze
curl -fsSLO https://raw.githubusercontent.com/lanternops/breeze/main/scripts/guided-setup.sh
chmod +x guided-setup.sh
./guided-setup.sh
```

The guided setup checks required commands, Docker Compose, CPU, RAM, and free disk space before generating configuration. It asks which Breeze release to install, downloads that release's `docker-compose.yml` and `.env.example`, preserves the comments from `.env.example` in your generated `.env`, prompts for the required settings, and can generate secure passwords and application secrets with `openssl rand`.

During setup you can choose the packaged Caddy reverse proxy, Nginx Proxy Manager, or another external reverse proxy path. You can also choose Docker named volumes or local `./data` subdirectories for persistent container data.

After the files are generated, the script lets you either stop with ready-to-use config files or continue into the guided start flow. The start flow prompts before pulling images and before running `docker compose up -d`, waits for the API to become healthy, then walks you through signing in with the one-time bootstrap credentials. Once you confirm first login is complete, it removes the bootstrap values from `.env`.

On Linux hosts with systemd, the guided setup can also install a reboot startup service for cleaner shutdowns and startups. On shutdown, it asks Docker Compose to stop the Breeze stack before Docker itself stops. On startup, it reruns Compose after Docker and networking are online, helping Breeze bring up Postgres/Redis, API/Web, and optional services in the intended order. The service stores its helper in a root-owned system path and points it at the setup directory you selected. For an existing guided install, run `./guided-setup.sh --install-systemd` from the Breeze setup directory.

### Option 3: Self-Hosted Manual Docker

Requires [Docker](https://docs.docker.com/get-docker/) and Docker Compose.

```bash
mkdir breeze && cd breeze
curl -fsSLO https://raw.githubusercontent.com/lanternops/breeze/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/lanternops/breeze/main/.env.example
# Caddy config — the compose file bind-mounts this, so it must exist on disk first.
# (If it's missing, Docker creates docker/Caddyfile.prod as a directory and Caddy fails.)
curl -fsSL --create-dirs -o docker/Caddyfile.prod https://raw.githubusercontent.com/lanternops/breeze/main/docker/Caddyfile.prod
cp .env.example .env

# Edit .env — at minimum set these:
#   BREEZE_DOMAIN        your domain (or "localhost" for local testing)
#   ACME_EMAIL           email for Let's Encrypt certs
#   JWT_SECRET           openssl rand -base64 64
#   AGENT_ENROLLMENT_SECRET  openssl rand -hex 32
#   APP_ENCRYPTION_KEY   openssl rand -hex 32
#   MFA_ENCRYPTION_KEY   openssl rand -hex 32
#   ENROLLMENT_KEY_PEPPER    openssl rand -base64 32
#   MFA_RECOVERY_CODE_PEPPER openssl rand -base64 32
#   BREEZE_BOOTSTRAP_ADMIN_EMAIL     your admin email, first boot only
#   BREEZE_BOOTSTRAP_ADMIN_PASSWORD  one-time value from `openssl rand -base64 32`
#
# BREEZE_VERSION ships pinned to a known-good release. Bump it to upgrade
# (see https://github.com/lanternops/breeze/releases for the current version).

# Optional — for remote desktop (WebRTC TURN relay):
#   TURN_HOST            public IP of your TURN server
#   TURN_SECRET          openssl rand -hex 32

docker compose up -d

# To enable TURN for remote desktop across NATs/firewalls:
# docker compose --profile turn up -d
```

Breeze will be running at `https://your-domain` (or `https://localhost` with a self-signed cert for local testing).

On first production boot against an empty database, Breeze creates the initial Partner Admin only from operator-provided `BREEZE_BOOTSTRAP_ADMIN_EMAIL` and `BREEZE_BOOTSTRAP_ADMIN_PASSWORD` values. If those values are missing, startup refuses to seed the empty production database. The password is never printed to logs. After you sign in and finish setup, remove those bootstrap values from `.env`.

For hardened production deploys (Cloudflare Tunnel, mandatory digest-pinned images, monitoring + logging), see [docs/operations/DEPLOY_PRODUCTION.md](docs/operations/DEPLOY_PRODUCTION.md) which uses `deploy/docker-compose.prod.yml`.

### Install the Agent

From your Breeze dashboard, navigate to **Settings → Agents → Download** to get the agent installer for your platform.

Or install directly:

```bash
# Build from source
cd agent
make build

# Binaries land in agent/bin/ — including breeze-agent, breeze-desktop-helper,
# breeze-watchdog, and breeze-backup.
# See docs/guides/AGENT_INSTALLATION.md for enrollment instructions.
```

### Enable the AI Operator (Optional)

1. Set `ANTHROPIC_API_KEY` in your `.env` (get one from the [Anthropic Console](https://console.anthropic.com/))
2. Restart the stack: `docker compose up -d`
3. The AI operator is now active on every page

Self-hosted deployments can also point the operator at any Anthropic-compatible endpoint (a proxy, a gateway like LiteLLM, or a third-party backend) via `ANTHROPIC_BASE_URL`; see the comments in `.env.example`.

---

## AI Operator

Breeze ships with the Claude Agent SDK integrated and an MCP server you can point any AI agent at. The AI isn't a separate product or plugin. It's woven into the platform, and the same risk engine governs every action whether it comes from the in-product chat or from an external agent over MCP.

### How It Works

The AI operator has access to **tools**: the same capabilities you have in the dashboard. When you ask it to investigate an alert, it can query device details, check event logs, run diagnostic scripts, and propose remediations. When it decides to take an action, that action passes through the **risk engine** before execution.

```
You: "Why is ACME-WS05 running slow?"

Operator: I'll investigate. Let me check the device health.
       → [calls get_device_details]
       → [calls get_event_stream]
       → [calls run_script: Get-Process | Sort-Object CPU -Descending | Select -First 10]

       ACME-WS05 has high CPU from Windows Update stuck in a retry loop.
       KB5034441 failed with error 0x80070643: the recovery partition
       is too small. I can fix this by extending the partition and
       retrying the update.

       ⚠️ This requires running a disk partition script (Risk: High).
       Approve? [Yes] [Modify] [Deny]
```

### Risk Classification

Every action the AI can take is classified by risk level. This is enforced by the RMM, not the AI. The operator cannot bypass it.

| Risk Level | Behavior | Examples |
|---|---|---|
| **Low** | Auto-execute, logged | Query devices, read logs, generate reports |
| **Medium** | Execute + notify tech | Run read-only scripts, deploy pre-approved patches |
| **High** | Requires human approval | State-changing scripts, patches outside maintenance window |
| **Critical** | Blocked entirely | Wipe device, bulk destructive operations |

Risk policies are fully configurable per partner, organization, site, or device group.

### Run It Yourself vs Managed AI Ops

Run the built-in AI yourself, free. Or add the managed team: AI agents that work your queue while we read their conversations, verify their fixes, and tune them with you.

| Capability | Run it yourself (free) | Managed AI Ops |
|---|---|---|
| AI chat on every page | ✅ | ✅ |
| Tool-equipped agent | ✅ | ✅ |
| Risk-classified actions | ✅ | ✅ |
| A team of agents working your queue | ❌ | ✅ |
| Persistent memory | ❌ | ✅ |
| Automated playbooks | ❌ | ✅ |
| Compliance evidence | ❌ | ✅ |
| Resolutions verified and agents tuned | You | The Breeze team, with you |
| Support | Community | Included |

Same Breeze. Same tools. Same risk engine. The difference is who does the work. Managed AI Ops is a curated engagement: we take on teams we can supervise properly. [Book a call →](https://breezermm.com/contact/)

---

## Architecture

### Multi-Tenant Hierarchy

```
Partner (MSP) → Organization (Customer) → Site (Location) → Device Group → Device
```

Every entity in Breeze is scoped to this hierarchy. Permissions, policies, alerts, and AI risk classifications cascade down and can be overridden at any level.

### Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Astro + React Islands |
| API | Hono (TypeScript) |
| Database | PostgreSQL with forced row-level security + Drizzle ORM |
| Queue | BullMQ + Redis |
| Agent | Go (cross-platform); native helper/viewer in Tauri (Rust) |
| Real-time | WebSocket + HTTP polling |
| Remote Access | WebRTC + coturn TURN relay |
| Reverse Proxy | Caddy with automatic Let's Encrypt |
| AI | Claude Agent SDK (Anthropic), MCP server with OAuth 2.1 |

### Brain Connector

The Brain Connector is the interface between the RMM and the AI, whether that's the built-in operator or the Managed AI Ops team. It exposes RMM capabilities as Agent SDK tools and enforces risk classification on every action.

```
┌─────────────────────────────┐
│  AI Operator                │
│  (built-in or Managed)      │
│         │                   │
│    Agent SDK                │
│    "I need to check this    │
│     device's patch status"  │
│         │                   │
│    calls get_patch_status() │
└─────────┬───────────────────┘
          │
          ▼
┌─────────────────────────────┐
│  Brain Connector            │
│  ┌───────────────────────┐  │
│  │   Risk Validator      │  │
│  │   (always enforced)   │  │
│  └───────────────────────┘  │
│         │                   │
│    RMM Core                 │
│    (devices, agents, data)  │
└─────────────────────────────┘
```

For detailed architecture documentation, see [docs/guides/architecture.md](docs/guides/architecture.md).

---

## Roadmap

### Now
- [x] Device inventory (hardware, software, network, security)
- [x] Remote terminal, file browser, desktop, activity monitoring
- [x] Remote scripting
- [x] Patch management with maintenance windows + update rings
- [x] Health checks & alerting
- [x] Configuration policies (hierarchical with feature links)
- [x] Advanced filtering
- [x] AI chat with tool-equipped agent (BYOK)
- [x] Risk-classified action engine
- [x] Multi-tenant hierarchy
- [x] macOS, Windows, and Linux agents
- [x] Network discovery (ARP, ICMP, port, SNMP)
- [x] Endpoint backup (snapshot, bare-metal recovery, Hyper-V, SQL Server)
- [x] Cloud-to-cloud backup (M365)
- [x] EDR integrations (SentinelOne, Huntress)
- [x] MCP server with OAuth 2.1 for external AI agents
- [x] Ticketing & help desk (SLA tracking, time & parts on the ticket)
- [x] Quotes, billing & invoicing, service catalog, customer portal
- [x] Native viewer + helper desktop apps (macOS, Windows)
- [x] Mobile app (iOS / Android): alerts, device status, on-call triage
- [x] Watchdog auto-restart and agent self-update
- [x] Reports & client-facing exports
- [x] CIS hardening checks and audit baselines
- [x] Email verification + cross-tenant abuse controls
- [x] Managed AI Ops (supervised AI team, curated engagements)

### Next
- [ ] Playbook engine (executable workflow runtime)
- [ ] Approval workflow UI for high-risk AI actions
- [ ] Expanded compliance framework evaluations
- [ ] External PSA sync (ConnectWise, Autotask, HaloPSA) for teams mid-migration
- [ ] Documentation platform integrations (IT Glue, Hudu)
- [ ] SSO (SAML, OIDC): implemented, awaiting field validation

### Later
- [ ] Cross-tenant intelligence
- [ ] Proactive remediation
- [ ] Marketplace for community playbooks

---

## Platform Support

| Platform | Agent Status | Notes |
|---|---|---|
| macOS | ✅ Working | Primary development platform; native helper + viewer |
| Windows | ✅ Working | Full feature parity with macOS; signed MSI installer + Watchdog service |
| Linux | ✅ Working | Daemon + service install via systemd; remote desktop and discovery require root |

---

## Support Breeze

Breeze is free and open source. If it helps your team, you can support ongoing development by [sponsoring LanternOps on GitHub](https://github.com/sponsors/LanternOps).

### Sponsors

<!-- sponsors:start -->
_No public sponsors yet. [Become the first sponsor →](https://github.com/sponsors/LanternOps)_
<!-- sponsors:end -->

---

## Contributing

Breeze is built by MSPs, for MSPs. Contributions are welcome.

### Getting Started

```bash
# Clone the repo
git clone https://github.com/lanternops/breeze.git
cd breeze

# Install dependencies
pnpm install

# Apply database migrations
pnpm db:migrate

# Start the dev server (API + web + helper)
pnpm dev

# Build the Go agent
cd agent
make build  # outputs to agent/bin/
```

### Ways to Contribute

- **Bug reports.** Found something broken? [Open an issue](https://github.com/lanternops/breeze/issues).
- **Feature requests.** Have an idea? [Start a discussion](https://github.com/lanternops/breeze/discussions).
- **Code.** Pick up an issue, submit a PR. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
- **Agent testing.** Run the agent on Windows/Linux and report what works and what doesn't.
- **Playbooks.** Share your remediation workflows so others can use them.
- **Documentation.** Help us make the docs better.

### Contributors

Thank you to everyone who has contributed to Breeze.

<!-- contributors:start -->
<a href="https://github.com/ToddHebebrand"><img src="https://avatars.githubusercontent.com/u/8375744?v=4&amp;s=128" width="64" height="64" alt="ToddHebebrand" title="ToddHebebrand (@ToddHebebrand)" /></a>
<a href="https://github.com/bdunncompany"><img src="https://avatars.githubusercontent.com/u/17571793?v=4&amp;s=128" width="64" height="64" alt="bdunncompany" title="bdunncompany (@bdunncompany)" /></a>
<a href="https://github.com/ramphex"><img src="https://avatars.githubusercontent.com/u/43665314?v=4&amp;s=128" width="64" height="64" alt="ramphex" title="ramphex (@ramphex)" /></a>
<a href="https://github.com/Emilien-Etadam"><img src="https://avatars.githubusercontent.com/u/56485277?v=4&amp;s=128" width="64" height="64" alt="Emilien-Etadam" title="Emilien-Etadam (@Emilien-Etadam)" /></a>
<a href="https://github.com/CookieSource"><img src="https://avatars.githubusercontent.com/u/36531905?v=4&amp;s=128" width="64" height="64" alt="CookieSource" title="CookieSource (@CookieSource)" /></a>
<!-- contributors:end -->

### Community

- [Discord](https://breezermm.com/discord): chat with the team and other MSPs
- [GitHub Discussions](https://github.com/lanternops/breeze/discussions): feature requests and ideas
- [Twitter/X](https://twitter.com/breeze_rmm): updates and announcements

---

## FAQ

**Is this really free?**
Yes. Breeze is AGPL-3.0 licensed. Self-host it, use it in production, manage as many endpoints as you want. Free forever.

**What's the catch?**
No catch. The business model sits on top of the free platform: [Breeze Cloud](https://breezermm.com/pricing/) (managed hosting, US and EU regions), support plans for self-hosters, and [Managed AI Ops](https://breezermm.com/brain/), where a supervised team of AI agents works your queue and we tune it with you. Breeze is great on its own. The paid tiers add hosting and workers.

**What is Managed AI Ops?**
AI agents working your alerts, patches, and tickets inside your own Breeze instance, with persistent memory, playbooks, and compliance evidence building up over time. The part no one else offers: we read the AI's conversations, verify its resolutions, and tune the agents as your fleet changes. Your risk engine holds the approvals throughout. Available on self-hosted or cloud Breeze. [Book a call](https://breezermm.com/contact/).

**How is this different from Tactical RMM?**
Tactical RMM is a solid project. Breeze is AI-native: the agent SDK and tool system are core to the architecture, not an integration. Breeze also has PSA built in (ticketing, quotes, billing, service catalog), built-in remote access (WebRTC), a modern frontend (Astro + React), and a multi-tenant hierarchy designed for MSPs from day one.

**Do I still need a separate PSA?**
No. Tickets, time tracking, quotes, invoicing, a priced service catalog, and a customer portal are built into Breeze. The ticket, the time behind it, and the invoice live in one system, so nothing gets re-keyed and nothing leaks between tools.

**Can I use this for my internal IT team (not an MSP)?**
Absolutely. The multi-tenant hierarchy works for internal IT too. Use Organizations as departments or offices.

**What AI models are supported?**
For the in-product AI operator, Breeze uses the Claude Agent SDK (Anthropic). BYOK mode takes an Anthropic API key, and self-hosted deployments can point at any Anthropic-compatible endpoint (such as a LiteLLM gateway). We chose Claude for its tool-use capabilities and reasoning quality. Separately, Breeze runs a built-in MCP server with OAuth 2.1 + PKCE, so you can connect Claude.ai, ChatGPT, Cursor, or any other MCP-compatible AI agent, using whichever model that platform runs. We're open to community contributions for additional in-product model providers.

**Is there an agent auto-update?**
Yes. The Breeze agent has a built-in updater that pulls signed release artifacts and self-installs across macOS, Windows, and Linux. The Watchdog service supervises the agent process and restarts it on failure. Production deployments verify Ed25519-signed release manifests via `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`.

**Is my data safe?**
Self-hosted: your data never leaves your infrastructure. Cloud-hosted: data is isolated per partner with strict tenant separation, in your choice of US or EU region. See our [Security Practices](docs/security/SECURITY_PRACTICES.md) for the full security whitepaper, including SOC 2 alignment mapping, encryption standards, and audit controls.

---

## License

Breeze is licensed under [AGPL-3.0](LICENSE).

You can use, modify, and self-host Breeze freely. If you modify Breeze and offer it as a service, you must open source your modifications under the same license.

---

<p align="center">
  Built by the team at <a href="https://breezermm.com">breezermm.com</a>
</p>
