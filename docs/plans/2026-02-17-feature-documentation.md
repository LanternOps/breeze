# Feature Documentation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Write user-facing documentation for 7 features shipped since the last docs update.

**Architecture:** Each task creates or updates one markdown file in `docs/`. Every doc follows the same structure: overview, key concepts, step-by-step usage, API reference, and troubleshooting notes. Docs are standalone and cross-referenced.

**Tech Stack:** Markdown, existing docs conventions (see `docs/ADMIN_GUIDE.md` for tone/format reference).

---

## Documents to create

| File | Features covered |
|---|---|
| `docs/CONFIGURATION_POLICIES.md` | Configuration Policy System |
| `docs/AI_FEATURES.md` | AI Risk Engine, Fleet Orchestration Brain, AI Device Context Memory |
| `docs/AGENT_DIAGNOSTICS.md` | Agent Diagnostic Log Shipping (BE-14), Agent Service Management |
| `docs/MANAGEMENT_POSTURE.md` | Management Posture Detection |

---

### Task 1: Configuration Policies documentation

**Files:**
- Create: `docs/CONFIGURATION_POLICIES.md`

**Context for writer:**

Configuration Policies are reusable bundles of settings that apply to devices via a priority hierarchy: Partner → Org → Site → Device Group → Device (device wins). They bundle 8 feature types: Patch Management, Alert Rules, Backup, Security, Monitoring, Maintenance Windows, Compliance, and Automation. Features can be "linked" (point to an existing policy ID) or "inline" (settings stored directly). Enforcement can be `monitor`, `warn`, or `enforce`. A `policyEvaluationWorker` runs on a 60s cycle.

**Step 1: Create the file with section headings**

```bash
# Create the file skeleton
touch docs/CONFIGURATION_POLICIES.md
```

Write this exact skeleton:

```markdown
# Configuration Policies

## Overview
## Key Concepts
### Policy hierarchy
### Feature types
### Enforcement modes
## Creating a Policy
## Adding Features to a Policy
### Patch Management
### Alert Rules
### Maintenance Windows
### Compliance Rules
### Backup, Security, Monitoring, Automation
## Assigning Policies
## Viewing Effective Configuration
## Patch Jobs
## API Reference
## Troubleshooting
```

**Step 2: Fill in Overview**

Write 2-3 paragraphs explaining:
- What a configuration policy is and the problem it solves (centralized settings management for large fleets)
- That policies are hierarchical (Partner → Org → Site → Device Group → Device, device-level wins)
- That policies are evaluated automatically on a schedule and can auto-remediate

**Step 3: Fill in Key Concepts**

*Policy hierarchy* — describe the 5 levels with a diagram:
```
Partner          (lowest priority)
  └── Organization
        └── Site
              └── Device Group
                    └── Device  (highest priority — always wins)
```

*Feature types* — table:
| Feature | What it controls |
|---|---|
| Patch Management | Auto-approval, schedule, reboot policy |
| Alert Rules | Conditions, severity, cooldown, templates |
| Maintenance Windows | Recurrence, duration, alert suppression |
| Compliance Rules | Desired-state rules, enforcement level, remediation |
| Backup | Schedule and retention |
| Security | Security policy settings |
| Monitoring | Check configuration |
| Automation | Event triggers, cron schedules, bulk actions |

*Enforcement modes* — `monitor` (report only), `warn` (log + notify), `enforce` (auto-remediate if script is set).

*Linked vs inline* — explain both: linked points to an existing object by ID; inline stores settings directly in the policy.

**Step 4: Fill in Creating a Policy**

Step-by-step UI walkthrough:
1. Navigate to **Configuration → Policies**
2. Click **New Policy**
3. Enter name, description, set status to Active
4. Save to open the policy detail editor

**Step 5: Fill in Adding Features to a Policy**

For each feature tab:
- Navigate to the feature tab in the policy editor
- Describe the key settings fields
- Note any linked vs inline options

Patch Management fields: auto-approve, schedule frequency/time, reboot policy.
Alert Rules: add conditions (metric, operator, value), severity, cooldown minutes, auto-resolve toggle.
Maintenance Windows: day of week/month, start time, duration, alert suppression toggle.
Compliance Rules: rule definition, enforcement level (monitor/warn/enforce), check interval, optional remediation script ID.

**Step 6: Fill in Assigning Policies**

1. Open the policy detail → **Assignments** tab
2. Choose target type: Partner / Organization / Site / Device Group / Device
3. Set priority (used for same-level conflicts; higher number wins)
4. Click Assign

Note: a device inherits from all levels; device-level assignment always wins regardless of priority.

**Step 7: Fill in Viewing Effective Configuration**

- Navigate to a device's detail page
- The effective configuration (merged from all inherited policies) is shown
- The inheritance chain shows which policy provided each setting

API: `GET /configuration-policies/effective/:deviceId` — returns merged config + full inheritance chain.

**Step 8: Fill in Patch Jobs**

Policies with patch settings can trigger deployment jobs:
- `POST /configuration-policies/:id/patch-job` with a list of device IDs
- Respects each device's maintenance window
- Creates deployment jobs with the policy's configured schedule

**Step 9: Fill in API Reference**

Compact table of all endpoints:

| Method | Path | Description |
|---|---|---|
| GET | `/configuration-policies` | List policies |
| POST | `/configuration-policies` | Create policy |
| GET | `/configuration-policies/:id` | Get policy |
| PATCH | `/configuration-policies/:id` | Update metadata |
| DELETE | `/configuration-policies/:id` | Delete (cascades) |
| GET | `/configuration-policies/:id/features` | List features |
| POST | `/configuration-policies/:id/features` | Add feature |
| PATCH | `/configuration-policies/:id/features/:linkId` | Update feature |
| DELETE | `/configuration-policies/:id/features/:linkId` | Remove feature |
| GET | `/configuration-policies/:id/assignments` | List assignments |
| POST | `/configuration-policies/:id/assignments` | Assign policy |
| DELETE | `/configuration-policies/:id/assignments/:aid` | Unassign |
| GET | `/configuration-policies/effective/:deviceId` | Resolve effective config |
| POST | `/configuration-policies/effective/:deviceId/diff` | Preview change diff |
| POST | `/configuration-policies/:id/patch-job` | Create patch deployment |

**Step 10: Fill in Troubleshooting**

- *Policy not applying to device* — Check that a policy is assigned at some level in the hierarchy. Use the Effective Configuration view to confirm.
- *Compliance check not running* — Ensure policy status is Active and `checkIntervalMinutes` is set. The evaluation worker runs every 60 seconds.
- *Patch job not respecting schedule* — Verify the device is not in an active maintenance window that suppresses patching.
- *Enforcement not remediating* — Enforcement mode must be `enforce` and a remediation script must be linked.

**Step 11: Commit**

```bash
git add docs/CONFIGURATION_POLICIES.md
git commit -m "docs: add Configuration Policies documentation"
```

---

### Task 2: AI Features documentation

**Files:**
- Create: `docs/AI_FEATURES.md`

**Context for writer:**

Three AI features to document:

**AI Risk Engine** — governance dashboard for AI-assisted operations. Categorizes tools into 4 tiers: Tier 1 (auto-execute, read-only, 36 tools), Tier 2 (auto-execute + audit logged, 3 tools), Tier 3 (requires human approval, 8 tools — e.g. execute_command, run_script, disk_cleanup, network_discovery), Tier 4 (blocked — cross-org access). Tracks approval history, rate limit violations, denials. Time range filter: 24h/7d/30d.

**Fleet Orchestration Brain** — AI-powered command center for fleet-scale operations. Dashboard shows 8 stat cards: policies, deployments, patches, alerts, device groups, automations, maintenance windows, reports. Exposes 8 AI tools: manage_policies, manage_deployments, manage_patches, manage_groups, manage_maintenance_windows, manage_automations, manage_alert_rules, generate_report. Quick action buttons pre-populate the AI chat with natural language prompts.

**AI Device Context Memory (BE-11)** — allows the AI to remember device-specific facts across conversations. Four context types: `issue` (known problems, e.g. recurring BSOD), `quirk` (device-specific behaviors), `followup` (pending actions), `preference` (user/device preferences). The AI can get, set, and resolve context entries. Context entries can have an expiry date. Three AI tools: `get_device_context` (Tier 1), `set_device_context` (Tier 2), `resolve_device_context` (Tier 2).

**Step 1: Create the file skeleton**

```markdown
# AI Features

## Overview
## AI Risk Engine
### Tool tiers
### Approval workflow
### Rate limits and denials
### Navigating to AI Risk Engine
## Fleet Orchestration Brain
### Dashboard metrics
### AI tools available
### Using quick actions
### Navigating to Fleet Orchestration
## AI Device Context Memory
### Context types
### How the AI uses context
### Managing context entries
## API Reference
```

**Step 2: Fill in Overview**

2 paragraphs:
- Breeze includes a built-in AI assistant that can query your fleet, diagnose issues, and take action on your behalf. Three features extend and govern this capability.
- Brief one-liner for each: Risk Engine (governance/audit), Fleet Brain (fleet-scale operations), Context Memory (remembers device history).

**Step 3: Fill in AI Risk Engine**

*Tool tiers* — explain the 4-tier system with a table:
| Tier | Execution | Examples |
|---|---|---|
| Tier 1 | Auto-execute (read-only) | query_devices, analyze_metrics, get_security_posture |
| Tier 2 | Auto-execute + audit logged | acknowledge alert, manage services list |
| Tier 3 | Requires approval | execute_command, run_script, disk_cleanup, network_discovery |
| Tier 4 | Blocked | Cross-org operations |

*Approval workflow* — when the AI proposes a Tier 3 action, it enters a pending state. An admin must approve or reject it in the Approval History feed before execution proceeds.

*Rate limits* — each tool has a sliding window limit (e.g. 10 commands/5min, 5 scripts/5min). Violations are logged in the Rejection & Denial Log.

*Navigation* — **Settings → AI → Risk Engine** or **AI → Risk Dashboard**

**Step 4: Fill in Fleet Orchestration Brain**

*Dashboard metrics* — describe the 8 stat cards and what each shows.

*AI tools* — table:
| Tool | What it does |
|---|---|
| manage_policies | List, evaluate, create, activate/deactivate, remediate policies |
| manage_deployments | Create, start, pause, resume, cancel deployments |
| manage_patches | Scan, approve, decline, defer, bulk approve, rollback |
| manage_groups | Create static/dynamic groups, manage membership |
| manage_maintenance_windows | Schedule windows with timezone support |
| manage_automations | Create/update automation rules and triggers |
| manage_alert_rules | Configure alerting templates per device/site |
| generate_report | Generate inventory, compliance, performance, executive reports |

*Quick actions* — describe the pre-populated AI chat buttons (Compliance Summary, Active Deployments, Critical Patches, Alert Overview, etc.).

*Navigation* — **Fleet → Orchestration** in the sidebar.

**Step 5: Fill in AI Device Context Memory**

*Context types* — table:
| Type | Purpose | Example |
|---|---|---|
| issue | Known problems to track | "Recurring BSOD on boot since Jan 2026" |
| quirk | Normal but unusual behavior | "Slow startup is expected due to legacy driver" |
| followup | Pending actions | "Check disk health after replacement on 2026-03-01" |
| preference | User/device preferences | "Maintenance window: Sundays 2am–4am only" |

*How AI uses context* — when you ask the AI about a device, it automatically loads that device's context entries and incorporates them in its analysis. This means it won't re-alert on known quirks or forget about open issues.

*Managing context* — you can ask the AI directly:
- "Remember that this device has a recurring BSOD issue"
- "Mark the disk check followup as resolved"
- "What do you know about DEVICE-NAME?"

Context entries can have expiry dates (useful for temporary followups).

**Step 6: Fill in API Reference**

Relevant AI admin endpoints:
| Method | Path | Description |
|---|---|---|
| GET | `/ai/admin/tool-executions` | Tool execution analytics (`?since=ISO&limit=1-200`) |
| GET | `/ai/admin/security-events` | Guardrail audit trail (`?since=ISO&limit=1-100&action=filter`) |

**Step 7: Commit**

```bash
git add docs/AI_FEATURES.md
git commit -m "docs: add AI Features documentation (Risk Engine, Fleet Orchestration, Device Context Memory)"
```

---

### Task 3: Agent Diagnostics & Service Management documentation

**Files:**
- Create: `docs/AGENT_DIAGNOSTICS.md`

**Context for writer:**

**Agent Diagnostic Logs (BE-14)** — agents ship structured logs (debug/info/warn/error) to the server as part of the heartbeat. Logs include: timestamp, component (heartbeat, websocket, main, updater), message, JSON fields, agent version. Stored in `agent_logs` table. Retention: configurable via `AGENT_LOG_RETENTION_DAYS` env var, default 7 days. UI: DeviceLogsTab component with filtering by level, component, time range, and full-text search. Pagination up to 1000/page.

**Agent Service Management** — users can list, start, stop, and restart OS services on a device. Works via command queue → WebSocket → agent (systemctl on Linux, launchctl on macOS, SCM on Windows). Synchronous with 30s timeout. Fully audit logged. Service info includes: name, display name, status (running/stopped/paused/starting/stopping), start type (auto/manual/disabled), binary path, account, dependencies.

**Step 1: Create the file skeleton**

```markdown
# Agent Diagnostics & Service Management

## Agent Diagnostic Logs
### What is logged
### Viewing logs in the UI
### Filtering and searching
### Log retention
### API reference
## Service Management
### Supported operations
### How it works
### Viewing services
### Starting, stopping, and restarting services
### Audit trail
### API reference
## Troubleshooting
```

**Step 2: Fill in Agent Diagnostic Logs**

*What is logged* — structured agent-internal logs (not OS event logs). Levels: debug, info, warn, error. Components: heartbeat, websocket, main, updater.

*Viewing in UI* — Navigate to a device's detail page → **Diagnostic Logs** tab. Logs appear in reverse chronological order with level badges (red=error, yellow=warn, blue=info, gray=debug).

*Filtering* — describe the available filters: level checkboxes, component dropdown, date/time range pickers, keyword search.

*Log retention* — logs are kept for 7 days by default. Admins can configure `AGENT_LOG_RETENTION_DAYS` in the server environment. A cleanup job runs daily.

*API reference*:
| Method | Path | Description |
|---|---|---|
| GET | `/devices/:id/diagnostic-logs` | Query logs |
| | `?level=warn,error` | Filter by level |
| | `?component=heartbeat` | Filter by component |
| | `?since=ISO&until=ISO` | Time range |
| | `?search=keyword` | Full-text search |
| | `?page=X&limit=Y` | Pagination (max 1000) |
| POST | `/agents/:id/logs` | (Agent only) Submit log batch |

**Step 3: Fill in Service Management**

*Supported operations* — List services, get service details, start, stop, restart. Works on Windows, macOS, and Linux.

*How it works* — commands are sent via BullMQ to the agent over WebSocket. The agent uses the appropriate service manager (SCM/Windows, launchctl/macOS, systemctl/Linux). Operations time out after 30 seconds.

*Viewing services* — Device detail → **Services** tab. Shows name, display name, current status, start type. Searchable and filterable by status.

*Starting/stopping/restarting* — click the action buttons next to any service. Confirm the dialog. Status updates after the operation completes.

*Audit trail* — all service operations are audit logged (actor, device, service name, action, result).

*API reference*:
| Method | Path | Description |
|---|---|---|
| GET | `/devices/:deviceId/services` | List services (`?search=&status=&page=&limit=`) |
| GET | `/devices/:deviceId/services/:name` | Get service details |
| POST | `/devices/:deviceId/services/:name/start` | Start service |
| POST | `/devices/:deviceId/services/:name/stop` | Stop service |
| POST | `/devices/:deviceId/services/:name/restart` | Restart service |

**Step 4: Fill in Troubleshooting**

- *No logs appearing* — agent may be running an older version that doesn't ship logs. Check the agent version in the device detail.
- *Log level missing* — the agent's local log level controls what gets shipped. Debug logs are only sent if the agent is in debug mode.
- *Service command timed out* — the agent must be online (WebSocket connected). If the device is offline or the WS is not established, commands queue and execute on reconnect.
- *Service not found* — service names are case-sensitive on some platforms. Use the list endpoint to confirm the exact name.

**Step 5: Commit**

```bash
git add docs/AGENT_DIAGNOSTICS.md
git commit -m "docs: add Agent Diagnostics and Service Management documentation"
```

---

### Task 4: Management Posture Detection documentation

**Files:**
- Create: `docs/MANAGEMENT_POSTURE.md`

**Context for writer:**

Management Posture Detection reveals what management, security, and compliance tools are installed or active on a device. Answers: "What is managing this endpoint?" Detects ~60 tools across 11 categories: MDM, RMM, Endpoint Security, Remote Access, Policy Engine, Backup, Identity/MFA, Zero Trust/VPN, SIEM, DNS Filtering, Patch Management. Each tool has a status: `active` (running), `installed` (present but not running), or `unknown` (detection error).

Detection methods by platform:
- **Windows**: Service queries (SCM), registry keys, file existence, dsregcmd (AD/Azure join status), GPO enumeration
- **macOS**: Process/service checks, launchd/launchctl status, `profiles list`, `dsconfigad` (AD binding)
- **Linux**: Basic process checks (partial support)

Identity detection: reports join type (`hybrid_azure_ad`, `azure_ad`, `on_prem_ad`, `workplace`, `none`), domain name, Azure tenant ID, MDM enrollment URL.

Updates every 15 minutes via heartbeat. Stored in `devices.management_posture` JSONB column.

**Step 1: Create the file skeleton**

```markdown
# Management Posture Detection

## Overview
## What is detected
### Tool categories
### Detection status
### Identity and directory detection
## Platform support
## Viewing posture in the UI
## Posture data freshness
## API reference
## Troubleshooting
```

**Step 2: Fill in Overview**

2 paragraphs:
- Management Posture Detection gives visibility into what tools are actively managing an endpoint — MDM, RMM, endpoint security, backup agents, identity providers, and more.
- Useful for: auditing management overlap, identifying unmanaged devices, confirming security tooling is active, and onboarding assessments.

**Step 3: Fill in What is detected**

*Tool categories* — table of 11 categories with examples:
| Category | Example tools |
|---|---|
| MDM | Microsoft Intune, JAMF, Mosyle, Kandji |
| RMM | ConnectWise Automate, NinjaOne, Datto, ScreenConnect |
| Endpoint Security | CrowdStrike, SentinelOne, Sophos, Bitdefender |
| Remote Access | TeamViewer, AnyDesk, Splashtop, LogMeIn |
| Policy Engine | SCCM/MECM, Group Policy, Chef, Puppet |
| Backup | Veeam, Acronis, Datto |
| Identity/MFA | Okta, Duo, JumpCloud |
| Zero Trust/VPN | Zscaler, Cloudflare WARP, Tailscale |
| SIEM | Splunk, Elastic, Wazuh |
| DNS Filtering | Cisco Umbrella, DNSFilter, Netskope |
| Patch Management | Automox, Windows Update |

*Detection status* — `active` (service/process running), `installed` (files/registry present but not running), `unknown` (error during detection).

*Identity detection* — describe the directory join info: join type, domain name, Azure tenant ID, MDM enrollment URL.

**Step 4: Fill in Platform support**

| Platform | Detection methods |
|---|---|
| Windows | Service queries (SCM), registry keys, file existence, dsregcmd, GPO enumeration |
| macOS | Process checks, launchd/launchctl, `profiles list`, `dsconfigad` |
| Linux | Basic process checks (partial — expanding in future releases) |

**Step 5: Fill in Viewing posture in the UI**

1. Navigate to a device's detail page
2. Click the **Management** tab
3. Tools are grouped by category with status badges
4. Identity/directory information appears in a separate card
5. The collection timestamp and scan duration are shown at the bottom

**Step 6: Fill in Posture data freshness**

Posture is collected every 15 minutes as part of the agent heartbeat. The last update time is shown in the UI. If a device goes offline, the posture reflects the last known state and is labelled with its age.

**Step 7: Fill in API reference**

| Method | Path | Description |
|---|---|---|
| GET | `/devices/:id/management-posture` | Get device posture snapshot |
| PUT | `/agents/:id/management/posture` | (Agent only) Submit posture data |

**Step 8: Fill in Troubleshooting**

- *Some tools not detected* — detection is signature-based. A tool may not be detected if it was installed in an unusual location or renamed. File an issue with the tool name and install path.
- *All tools show "unknown"* — the agent may not have sufficient permissions to query services or registry keys. On Windows, the agent service account needs read access to SCM.
- *macOS MDM not detected* — MDM profiles detection requires the agent to run as root (or with sudo privileges for `profiles list`).
- *Posture not updating* — check the device is online and the agent is running. Posture is updated every 15 minutes; a missed heartbeat delays the update.

**Step 9: Commit**

```bash
git add docs/MANAGEMENT_POSTURE.md
git commit -m "docs: add Management Posture Detection documentation"
```

---

## Execution options

**Plan complete and saved to `docs/plans/2026-02-17-feature-documentation.md`.**

**1. Subagent-Driven (this session)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Parallel Session (separate)** — open a new session in the worktree with `executing-plans`, batch execution with checkpoints.

Which approach?
