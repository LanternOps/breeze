<p align="center">
  <img src="docs/assets/breeze-logo.png" alt="Breeze" width="120" />
</p>

<h1 align="center">Breeze</h1>

<p align="center">
  <strong>The open source, AI-native RMM.</strong><br/>
  Monitor, manage, and remediate — with an AI brain built in.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#features">Features</a> •
  <a href="#ai-brain">AI Brain</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#roadmap">Roadmap</a> •
  <a href="#contributing">Contributing</a> •
  <a href="#license">License</a>
</p>

<p align="center">
  <a href="https://github.com/lanternops/breeze/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License" /></a>
  <a href="https://github.com/lanternops/breeze/releases"><img src="https://img.shields.io/github/v/release/lanternops/breeze" alt="Release" /></a>
  <a href="https://breezermm.com/discord"><img src="https://img.shields.io/discord/000000000?label=discord" alt="Discord" /></a>
</p>

---

## What is Breeze?

Breeze is a full-featured remote monitoring and management platform with AI built into its core — not bolted on as an afterthought.

Software features are exploding, but people can't keep up. Every RMM on the market adds more buttons, more tabs, more dashboards. Breeze takes a different approach: **an AI agent that actually uses the features for you.** It investigates alerts, remediates issues, documents what it did, and only bothers you when it needs a human decision.

Breeze is free, open source (AGPL-3.0), and designed to be self-hosted or [cloud-hosted through LanternOps](https://lanternops.io).

### Why Breeze?

- **AI-native, not AI-added.** Every page has an AI assistant that can see what you see and take action using built-in tools. Not a chatbot — an agent.
- **Lightweight agent.** Single Go binary. Cross-platform. Minimal resource footprint. Your clients won't notice it's there.
- **Actually open source.** AGPL-3.0. Read every line. Fork it. Contribute. No bait-and-switch.
- **Multi-tenant from day one.** Built for MSPs managing multiple clients, not retrofitted from a single-tenant architecture.
- **Modern stack.** Not a legacy codebase with 15 years of technical debt. Clean, fast, extensible.

---

## Features

### Device Management
- **Hardware & software inventory** — CPU, memory, storage, network, installed applications, versions
- **Real-time device health** — Health checks with configurable thresholds and alerting
- **Policies** — Define and enforce configuration policies across device groups
- **Advanced filtering** — Query your fleet with powerful filters across any device attribute
- **Network discovery** — Scan and map networks to find unmanaged devices *(in progress)*

### Remote Access
- **Remote terminal** — Full shell access to managed devices
- **Remote file browser** — Browse, upload, and download files
- **Remote desktop** — Visual remote control of devices
- **Activity monitoring** — See what's happening on a device in real time

### Automation
- **Remote scripting** — Execute scripts (PowerShell, Bash, Python) across devices
- **Patch management** — Inventory, approve, and deploy OS and application patches
- **Alerting** — Configurable alerts with severity classification and routing
- **Backup** — Managed backup for critical device data *(in progress)*

### AI Brain (BYOK)
- **AI chat on every page** — Context-aware assistant that knows what you're looking at
- **Tool-equipped agent** — The AI doesn't just talk, it acts — querying devices, running diagnostics, executing remediations
- **Risk-classified actions** — Every AI action is validated against a risk engine before execution. Dangerous actions require human approval. Always.
- **Bring your own key** — Plug in your Anthropic API key and the brain works out of the box

> **🧠 [LanternOps Brain](https://lanternops.com)** — Want persistent memory, cross-tenant intelligence, automated playbooks, and compliance evidence generation? LanternOps is the managed AI brain for Breeze. Same RMM, smarter brain. [Learn more →](https://lanternops.com)

---

## Quick Start

### Option 1: Cloud Hosted (Easiest)

Skip infrastructure entirely. [Sign up at LanternOps](https://lanternops.com) and have a fully managed Breeze instance in minutes.

### Option 2: Self-Hosted (Docker)

```bash
# Clone the repo
git clone https://github.com/lanternops/breeze.git
cd breeze

# Copy and configure environment
cp .env.example .env
# Edit .env with your database credentials and settings

# Start everything
docker compose up -d
```

Breeze will be running at `http://localhost:3000`.

### Install the Agent

From your Breeze dashboard, navigate to **Settings → Agents → Download** to get the agent installer for your platform.

Or install directly:

```bash
# macOS
curl -fsSL https://your-breeze-instance/api/agent/install/macos | bash

# Windows (PowerShell, run as Administrator)
irm https://your-breeze-instance/api/agent/install/windows | iex

# Linux
curl -fsSL https://your-breeze-instance/api/agent/install/linux | bash
```

### Enable the AI Brain (Optional)

1. Go to **Settings → AI Brain → BYOK**
2. Enter your [Anthropic API key](https://console.anthropic.com/)
3. The AI assistant is now active on every page

---

## AI Brain

Breeze ships with the Claude Agent SDK integrated. The AI isn't a separate product or plugin — it's woven into the platform.

### How It Works

The AI brain has access to **tools** — the same capabilities you have in the dashboard. When you ask it to investigate an alert, it can query device details, check event logs, run diagnostic scripts, and propose remediations. When it decides to take an action, that action passes through the **risk engine** before execution.

```
You: "Why is ACME-WS05 running slow?"

Brain: I'll investigate. Let me check the device health.
       → [calls get_device_details]
       → [calls get_event_stream]
       → [calls run_script: Get-Process | Sort-Object CPU -Descending | Select -First 10]

       ACME-WS05 has high CPU from Windows Update stuck in a retry loop.
       KB5034441 failed with error 0x80070643 — the recovery partition
       is too small. I can fix this by extending the partition and
       retrying the update.

       ⚠️ This requires running a disk partition script (Risk: High).
       Approve? [Yes] [Modify] [Deny]
```

### Risk Classification

Every action the AI can take is classified by risk level. This is enforced by the RMM, not the AI — the brain cannot bypass it.

| Risk Level | Behavior | Examples |
|---|---|---|
| **Low** | Auto-execute, logged | Query devices, read logs, generate reports |
| **Medium** | Execute + notify tech | Run read-only scripts, deploy pre-approved patches |
| **High** | Requires human approval | State-changing scripts, patches outside maintenance window |
| **Critical** | Blocked entirely | Wipe device, bulk destructive operations |

Risk policies are fully configurable per partner, organization, site, or device group.

### BYOK vs LanternOps Brain

| Capability | BYOK (Free) | LanternOps Brain |
|---|---|---|
| AI chat on every page | ✅ | ✅ |
| Tool-equipped agent | ✅ | ✅ |
| Risk-classified actions | ✅ | ✅ |
| Persistent memory | ❌ | ✅ |
| Cross-tenant intelligence | ❌ | ✅ |
| Automated playbooks | ❌ | ✅ |
| Proactive remediation | ❌ | ✅ |
| Compliance evidence | ❌ | ✅ |
| Client-facing reports | ❌ | ✅ |
| Escalation routing | ❌ | ✅ |

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
| Database | PostgreSQL + Drizzle ORM |
| Queue | BullMQ + Redis |
| Agent | Go (cross-platform) |
| Real-time | HTTP polling + WebSocket |
| Remote Access | WebRTC |
| AI | Claude Agent SDK (Anthropic) |

### Brain Connector

The Brain Connector is the interface between the RMM and any AI brain (BYOK or LanternOps). It exposes RMM capabilities as Agent SDK tools and enforces risk classification on every action.

```
┌─────────────────────────────┐
│  AI Brain                   │
│  (BYOK local or LanternOps) │
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

For detailed architecture documentation, see [docs/architecture.md](docs/architecture.md).

---

## Roadmap

### Now
- [x] Device inventory (hardware, software, network, security)
- [x] Remote terminal
- [x] Remote file browser
- [x] Remote desktop
- [x] Activity monitoring
- [x] Remote scripting
- [x] Patch management
- [x] Health checks & alerting
- [x] Policies
- [x] Advanced filtering
- [x] AI chat with tool-equipped agent (BYOK)
- [x] Risk-classified action engine
- [x] Multi-tenant hierarchy
- [x] macOS agent
- [ ] Windows agent testing & hardening
- [ ] Linux agent testing & hardening
- [ ] Network discovery
- [ ] Backup

### Next
- [ ] LanternOps Brain connector (managed AI brain)
- [ ] Event stream architecture (RMM → Brain)
- [ ] Playbook engine
- [ ] Approval workflow UI
- [ ] Compliance framework evaluations
- [ ] Client-facing report generation
- [ ] Agent auto-update mechanism

### Later
- [ ] Cross-tenant intelligence
- [ ] Proactive remediation
- [ ] Mobile app
- [ ] Marketplace for community playbooks
- [ ] PSA integration (ConnectWise, Autotask, HaloPSA)
- [ ] Documentation platform integration (IT Glue, Hudu)

---

## Platform Support

| Platform | Agent Status | Notes |
|---|---|---|
| macOS | ✅ Stable | Primary development platform |
| Windows | 🧪 Built, testing | Go cross-compiled, core features working |
| Linux | 🧪 Built, testing | Go cross-compiled, core features working |

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

# Set up the database
pnpm db:migrate

# Start the dev server
pnpm dev

# Build the Go agent
cd agent
go build -o breeze-agent ./cmd/agent
```

### Ways to Contribute

- **Bug reports** — Found something broken? [Open an issue](https://github.com/lanternops/breeze/issues).
- **Feature requests** — Have an idea? [Start a discussion](https://github.com/lanternops/breeze/discussions).
- **Code** — Pick up an issue, submit a PR. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
- **Agent testing** — Run the agent on Windows/Linux and report what works and what doesn't.
- **Playbooks** — Share your remediation workflows so others can use them.
- **Documentation** — Help us make the docs better.

### Community

- [Discord](https://discord.gg/breeze-rmm) — Chat with the team and other MSPs
- [GitHub Discussions](https://github.com/lanternops/breeze/discussions) — Feature requests and ideas
- [Twitter/X](https://twitter.com/breeze_rmm) — Updates and announcements

---

## FAQ

**Is this really free?**
Yes. Breeze is AGPL-3.0 licensed. Self-host it, use it in production, manage as many endpoints as you want. Free forever.

**What's the catch?**
No catch. The business model is [LanternOps](https://lanternops.com) — a managed AI brain that connects to Breeze and adds persistent memory, cross-tenant intelligence, automated playbooks, and compliance evidence. Breeze is great on its own. LanternOps makes it autonomous.

**How is this different from Tactical RMM?**
Tactical RMM is a solid project. Breeze is AI-native — the agent SDK and tool system are core to the architecture, not an integration. We also have built-in remote access (WebRTC), a modern frontend (Astro + React), and a multi-tenant hierarchy designed for MSPs from day one.

**Can I use this for my internal IT team (not an MSP)?**
Absolutely. The multi-tenant hierarchy works for internal IT too — just use Organizations as departments or offices.

**What AI models are supported?**
Breeze uses the Claude Agent SDK (Anthropic). BYOK mode requires an Anthropic API key. We chose Claude for its tool-use capabilities and reasoning quality. We're open to community contributions for other model support.

**Is my data safe?**
Self-hosted: your data never leaves your infrastructure. Cloud-hosted: data is isolated per partner with strict tenant separation. See [docs/security.md](docs/security.md) for details.

---

## License

Breeze is licensed under [AGPL-3.0](LICENSE).

You can use, modify, and self-host Breeze freely. If you modify Breeze and offer it as a service, you must open source your modifications under the same license.

---

<p align="center">
  Built by <a href="https://lanternops.com">LanternOps</a> · Made for MSPs
</p>
