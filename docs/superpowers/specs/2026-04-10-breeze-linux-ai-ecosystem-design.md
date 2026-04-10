# Breeze Linux & AI Ecosystem — Strategic Design

**Date:** 2026-04-10
**Status:** Approved
**Scope:** Multi-phase strategic vision — Linux enterprise management ecosystem + AI-native productivity platform

---

## The Thesis

AI eliminates the productivity application layer. When AI agents can write documents, manage relationships, query data, and orchestrate workflows directly through tool calls, the OS becomes the primary surface again — and whoever controls the management plane for that OS wins.

Linux's structural advantage in this world:
- Open source: auditable, modifiable, AI-toolable at every layer
- No per-seat licensing lock-in
- Government and enterprise flight from Microsoft accelerating (France, others)
- AI tooling (MCP, agent frameworks) natively integrates with the Unix process model
- Open protocols for communication (SMTP, Matrix, WebRTC) mean no ecosystem tax

**Breeze's position:** The open-source management ecosystem for enterprise Linux desktops and servers — making Linux fleets manageable the way Windows fleets are today, designed AI-native from the start.

**Business model:** Everything open source. Monetization through Breeze Cloud (managed hosting + managed service). MSP-first (multi-tenant rails already exist), enterprise/government direct second. Open source components drive bottom-up adoption; Breeze Cloud is the obvious managed layer.

---

## Full Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                         BREEZE CLOUD                               │
│                                                                    │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────────┐  │
│  │   MCP Server    │  │  Comms Layer     │  │  Document Store │  │
│  │   (existing)    │  │  email / chat /  │  │  .md git-backed │  │
│  │  fleet AI ops   │  │  VoIP signaling  │  │  per-org        │  │
│  └─────────────────┘  └──────────────────┘  └─────────────────┘  │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  AI Self-Assembly Engine                                   │   │
│  │  Reads .md data → assembles CRM, PM, reporting on demand  │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  Management Plane: fleet policy · identity broker · patching      │
│  Multi-tenant: Partner → Org → Site → Device Group → Device      │
└───────────────────────────┬────────────────────────────────────────┘
                            │ API + MCP
       ┌────────────────────┼───────────────────┐
       ▼                    ▼                   ▼
 ┌──────────┐   ┌────────────────┐   ┌──────────────┐   ┌────────────────┐
 │  breeze  │   │    breeze-     │   │   breeze-    │   │   breeze-mcp   │
 │  agent   │   │   identity     │   │   policy     │   │  (device-side) │
 │(existing)│   │   (new)        │   │   (new)      │   │   (new)        │
 └──────────┘   └────────────────┘   └──────────────┘   └────────────────┘
 monitoring      Linux auth           config push         device MCP server
 patching        SSH keys             CIS hardening       exposes OS as tools
 remote access   PAM integration      offline enforce     feeds cloud MCP
```

---

## Sub-system 1: Linux Management Modules

### `breeze-agent` (existing, extended)

The existing Go agent gains Linux depth:

- **Patch management**: `apt` / `dnf` / `zypper` orchestration with approval workflows, scheduling, rollback. Distro-agnostic abstraction layer.
- **Package inventory**: Full `dpkg` / `rpm` enumeration — name, version, install date, source.
- **systemd service management**: List services, start/stop/restart, alert on failed units, monitor crash loops.
- **LUKS encryption status**: Report encryption state, key slot count. Enforce via `breeze-policy`.
- **Local user/group inventory**: All local accounts, sudo group membership, last login times.
- **Security posture reporting**: SSH config audit (`PermitRootLogin`, key-only enforcement), SUID binary scan, ufw/iptables/nftables state, open port enumeration, CIS benchmark score.

Distro support: Ubuntu LTS, Debian, Fedora, RHEL/Rocky/Alma.

---

### `breeze-identity` (new module)

**Fills the Active Directory / Entra gap for Linux.**

A lightweight PAM-integrated daemon that handles Linux device identity, designed for MSPs managing heterogeneous Linux fleets.

**Capabilities:**
- Device enrollment to identity provider: Entra ID, Okta, LDAP, or Breeze-native directory
- Local credential caching — offline login works when cloud is unreachable
- SSH key distribution from central directory — keys provisioned/revoked from Breeze UI
- PAM module integration — Linux login (`su`, `sudo`, SSH, display manager) goes through `breeze-identity`
- Group membership sync — Linux groups mirror cloud directory groups
- MFA enforcement — TOTP/push via provider, enforced at PAM layer

**What it is not:** A full domain controller. It is a client-side identity daemon that connects Linux devices to cloud identity. No Kerberos KDC required.

**Delivery:** `breeze-identity` deb/rpm package. Systemd service. Open source. Integrates with Breeze Cloud for directory sync; usable standalone with LDAP.

---

### `breeze-policy` (new module)

**Fills the Group Policy gap for Linux.**

A systemd service that pulls policy definitions from Breeze Cloud and enforces them natively, offline-capable.

**Policy primitives:**
- Screen lock: idle timeout, lock-on-suspend
- USB storage: enable/disable by device class
- Firewall rules: ufw/nftables abstraction, push rules from Breeze UI
- Package restrictions: allowlist / blocklist enforced via `apt`/`dnf` hooks
- SSH configuration: enforce `PermitRootLogin no`, key-only auth, allowed users
- LUKS enforcement: require encryption, escrow recovery key to Breeze Cloud
- CIS profiles: Level 1 / Level 2 benchmark enforcement with remediation
- Mount restrictions: block removable media, control NFS/CIFS mounts
- sudo policy: restrict sudo to specific commands, require MFA for escalation

**Policy lifecycle:** Defined in Breeze UI → pushed to device via API → enforced by `breeze-policy` daemon → compliance status reported back to Breeze → visible in dashboard and audit log.

**Offline behavior:** Policies cached locally. Device remains enforced when disconnected. On reconnect, drift detection runs and reports violations.

**Delivery:** `breeze-policy` deb/rpm. Open source. Usable standalone with a local policy file; full lifecycle management requires Breeze Cloud.

---

### `breeze-mcp` (new module — device-side)

**Closes the AI loop: makes each Linux device AI-addressable.**

An MCP server running on each device, exposing local OS capabilities as tools. Feeds upward to Breeze Cloud MCP, enabling AI agents to manage individual devices or entire fleets.

**Exposed tools (examples):**
- `read_file`, `write_file`, `list_directory` (within policy-defined bounds)
- `install_package`, `remove_package`, `query_packages`
- `start_service`, `stop_service`, `get_service_status`
- `list_users`, `create_user`, `lock_user`
- `get_hardware_info`, `get_disk_usage`, `get_network_interfaces`
- `run_script` (policy-gated, audit-logged)
- `stream_logs` (systemd journal query)
- `get_security_posture`

**Data flow:**
```
AI Agent → Breeze Cloud MCP → breeze-mcp (on device) → OS
```

Fleet-level: "Patch all devices in site-london that are running kernel < 6.8" — Cloud MCP fans out to `breeze-mcp` on each device, executes, aggregates results.

**Security:** All tool calls authenticated via existing agent token. Policy-gated: `breeze-policy` defines what `breeze-mcp` is allowed to do. Full audit log.

---

## Sub-system 2: Communication Layer

### Email

- Self-hosted SMTP/IMAP per org (Maddy or Postfix/Dovecot under the hood)
- Each Breeze org gets domain-scoped email (`user@acme.breeze.email` or custom domain via DNS delegation)
- AI-managed inbox: triage, draft, summarize, schedule send
- Inbox as query surface: "show me all unread from enterprise customers this week"
- Standard IMAP — any mail client works; Breeze web UI is the AI-native interface
- Open protocol: full interop with external mail systems

### Chat

- Matrix protocol (open, federated, E2E encrypted)
- Per-org workspaces, per-site channels, direct messages, threads
- AI agent participates natively: `@breeze patch site-london tonight`
- Matrix bridges: Slack, Teams, SMS, WhatsApp — interop is free via existing bridge ecosystem
- Self-hosted Synapse or Conduit (lighter Go implementation) per org cluster

### VoIP / Video

- **1:1 calls**: Browser-to-browser WebRTC using existing Breeze signaling infrastructure. ICE/STUN/TURN already configured. Opus audio already in registered codec list. Browser uses `getUserMedia` (camera/mic) instead of `getDisplayMedia` — minimal new work. Call routing path added alongside existing desktop session routing.
- **Multi-party (3+ participants)**: Pion-based SFU (Selective Forwarding Unit). Pion is the Go WebRTC library already integrated in the agent — the same team, same library, proven in production for remote desktop.
- **Screen share during call**: Already works — same video track mechanism as remote desktop.
- No new STUN/TURN infrastructure required.

---

## Sub-system 3: Document & Data Layer

### The Model: Everything Is a File

```
org/
  people/
    alice.md          # contact record (YAML frontmatter + prose)
    bob.md
  deals/
    acme-q2.md        # CRM record
    globex-renewal.md
  projects/
    linux-migration.md
    q2-onboarding.md
  notes/
    2026-04-10-standup.md
  data/
    budget-2026.csv   # structured data when needed
  .breeze/
    views/
      pipeline.md     # saved AI query — runs on load
      open-projects.md
```

**Core principles:**
- Git-backed per org — full audit history, branching, diffing, blame built-in
- YAML frontmatter carries structured metadata; body is human/AI-readable prose
- AI reads and writes these files natively via `breeze-mcp` file tools — no schema migrations, no ORM, no data model to design
- Plain text is the record. AI is the interface. Export is the compatibility shim.

**Export pipeline:**
- `.md` → PDF, DOCX, XLSX, PPTX, HTML via Pandoc (runs on-demand)
- "Send this proposal as a PDF" → AI renders frontmatter + body → exports → attaches to email
- No lock-in: files are always readable without Breeze

**Structured data:**
- YAML/TOML frontmatter for fields (deal stage, contact email, project status)
- CSV/TSV for tabular data when needed
- AI handles schema evolution — add a field to a template, AI backfills existing records

---

## Sub-system 4: AI Self-Assembly Layer

### No Fixed Applications

The AI assembles the right tool for the task from the user's data on demand. No SaaS subscriptions, no data exports, no schema migrations.

| Legacy SaaS | Breeze AI equivalent |
|---|---|
| Salesforce | `show pipeline this quarter` → AI reads `deals/*.md`, assembles kanban/table view |
| Jira/Linear | `what's blocked on linux migration?` → AI reads `projects/*.md`, surfaces blockers |
| Excel | `budget variance vs last year` → AI reads `data/*.csv`, renders comparison table |
| Notion | `.md` files + AI = Notion without the lock-in |
| Outlook | AI triages `email/`, drafts replies, summarizes threads, schedules sends |
| Slack | Matrix chat + Pion calls + AI as native participant |
| Zoom | WebRTC 1:1 + Pion SFU for groups |
| HR system | `people/*.md` + AI = org chart, onboarding checklists, review tracking |

### How It Works

- Breeze Cloud MCP (existing) gains document tools: `read_file`, `write_file`, `list_files`, `search_files`, `git_log`, `git_diff`
- AI agents query, transform, and write `.md` files through MCP — the same interface used to manage devices
- The "application" is the AI's response, rendered in the Breeze web UI — ephemeral, assembled fresh, never stale
- Saved views are AI queries stored as `.breeze/views/*.md` — re-run on load, parameterized, shareable
- The AI layer IS the interface layer — no separate frontend app per use case

### Fleet + Productivity Unified

The same AI interface manages both the device estate and the productivity layer:

```
"Onboard Alice Chen starting Monday"
→ AI creates people/alice-chen.md
→ provisions breeze-identity credentials for her devices
→ applies breeze-policy onboarding profile to her laptop
→ adds her to the #engineering Matrix channel
→ sends welcome email from her new org mailbox
→ creates project/alice-onboarding.md with 30-day checklist
```

One prompt. Seven systems. No manual steps.

---

## Build Sequence

| Phase | Deliverable | Rationale |
|---|---|---|
| **1** | Linux agent depth: patching, package inventory, systemd, LUKS, security posture | Near-term revenue, validates Linux market, funds everything else |
| **2** | `breeze-identity` module | Biggest gap, highest differentiation, unlocks enterprise sales |
| **3** | `breeze-policy` module | Group Policy equivalent, required for government/compliance buyers |
| **4** | 1:1 VoIP/video (WebRTC extension) | Low effort (infrastructure done), high value, competitive differentiation |
| **5** | Matrix chat integration | Open protocol, federation free, bridges to Slack/Teams |
| **6** | Email layer (SMTP/IMAP + AI triage) | Completes communication stack |
| **7** | `.md` document store + git backend + export pipeline | Data foundation for AI self-assembly |
| **8** | `breeze-mcp` device-side module | Closes AI loop, device fleet becomes AI-addressable |
| **9** | AI self-assembly layer (MCP document tools + fleet+productivity unified) | The end state — AI manages everything |
| **10** | Pion SFU multi-party calls | Conference calling, completes VoIP story |

---

## Competitive Moat

| Moat | Description |
|---|---|
| Open source | No lock-in narrative. Community drives adoption. Forks validate the standard. |
| First mover | Building the missing Linux enterprise infrastructure before anyone else |
| MSP multi-tenancy | Years of architectural investment already done. Hard to copy quickly. |
| AI-native from day 1 | Not retrofitting AI onto legacy architecture. MCP is the interface layer. |
| Protocol alignment | SMTP, Matrix, WebRTC, git — open protocols mean ecosystem interop is free |
| Unified surface | Device management + productivity + communication in one AI interface |

---

## What This Is Not

- **Not a Linux distro.** These are modules that work on any major distro.
- **Not a Microsoft clone.** Not building AD, not building Exchange, not building SharePoint. Building the AI-native equivalents that solve the same problems differently.
- **Not locked to Breeze Cloud.** Every module usable standalone. Breeze Cloud is the best management layer, not the only one.
- **Not speculative.** Every piece builds on infrastructure already in Breeze: Go agent, WebRTC (Pion), MCP server, multi-tenant API, PostgreSQL, BullMQ.
