# RMM ↔ LanternOps Orchestration Architecture
## Using Claude Agent SDK as the Brain Interface

---

## Core Concept

The open source RMM exposes its capabilities as **Claude Agent SDK tools**. This means the API contract between the RMM and any brain (BYOK or LanternOps) is literally the tool definitions. The RMM is a tool server. The brain is the agent that uses those tools.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   LanternOps Cloud                  │
│                  (Commercial Brain)                 │
│                                                     │
│  ┌─────────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Cross-Tenant │  │ Playbook │  │  Compliance   │  │
│  │ Intelligence │  │  Engine  │  │   Evidence    │  │
│  └──────┬──────┘  └────┬─────┘  └───────┬───────┘  │
│         │              │                │           │
│  ┌──────▼──────────────▼────────────────▼────────┐  │
│  │          Claude Agent SDK (Orchestrator)       │  │
│  │  - Persistent memory per tenant                │  │
│  │  - Multi-step workflow execution               │  │
│  │  - Escalation & approval routing               │  │
│  └──────────────────┬───────────────────────────┘  │
│                     │                               │
└─────────────────────┼───────────────────────────────┘
                      │ Authenticated API
                      │ (Tools = RMM Capabilities)
┌─────────────────────┼───────────────────────────────┐
│    Open Source RMM   │   (Self-Hosted by MSP)       │
│                     │                               │
│  ┌──────────────────▼──────────────────────────┐    │
│  │           Brain Connector Interface          │    │
│  │  - Exposes RMM actions as Agent SDK tools    │    │
│  │  - Emits events as structured messages       │    │
│  │  - Handles auth (LanternOps or BYOK)         │    │
│  └──────┬──────────┬──────────┬────────────┘    │
│         │          │          │                  │
│  ┌──────▼───┐ ┌────▼────┐ ┌──▼──────────┐      │
│  │ Device   │ │ Alert   │ │  Execution  │      │
│  │ Manager  │ │ Engine  │ │  Engine     │      │
│  └──────────┘ └─────────┘ └─────────────┘      │
│         │          │          │                  │
│  ┌──────▼──────────▼──────────▼────────────┐    │
│  │         Managed Endpoints                │    │
│  └──────────────────────────────────────────┘    │
└──────────────────────────────────────────────────┘
```

---

## The Tool Contract (This IS the API)

The RMM registers its capabilities as Claude Agent SDK tools. This is the
boundary between open source and commercial. Anyone can call these tools
with BYOK. LanternOps calls them smarter.

### Device Management Tools

```python
# These tool definitions ship with the open source RMM.
# They're what the Claude agent (BYOK or LanternOps) can call.

tools = [
    {
        "name": "list_devices",
        "description": "List managed devices with optional filters. Returns device ID, hostname, OS, last seen, health status, compliance state.",
        "input_schema": {
            "type": "object",
            "properties": {
                "tenant_id": {"type": "string"},
                "filters": {
                    "type": "object",
                    "properties": {
                        "os_type": {"enum": ["windows", "macos", "linux"]},
                        "status": {"enum": ["online", "offline", "degraded"]},
                        "compliance": {"enum": ["compliant", "non_compliant", "unknown"]},
                        "group": {"type": "string"},
                        "search": {"type": "string"}
                    }
                },
                "include_details": {
                    "type": "array",
                    "items": {"enum": ["hardware", "software", "patches", "policies"]}
                }
            },
            "required": ["tenant_id"]
        }
    },
    {
        "name": "get_device_details",
        "description": "Get comprehensive details about a specific device including hardware specs, installed software, patch status, applied policies, recent events, and performance metrics.",
        "input_schema": {
            "type": "object",
            "properties": {
                "device_id": {"type": "string"},
                "sections": {
                    "type": "array",
                    "items": {"enum": [
                        "hardware", "software", "patches",
                        "policies", "events", "performance",
                        "security", "network", "storage"
                    ]}
                }
            },
            "required": ["device_id"]
        }
    },
    {
        "name": "execute_action",
        "description": "Execute a management action on one or more devices. Some actions require approval based on risk level.",
        "input_schema": {
            "type": "object",
            "properties": {
                "device_ids": {
                    "type": "array",
                    "items": {"type": "string"}
                },
                "action": {
                    "enum": [
                        "reboot", "shutdown", "wake_on_lan",
                        "lock", "wipe",
                        "install_patch", "install_software", "uninstall_software",
                        "run_script", "run_scan",
                        "enable_firewall", "disable_firewall",
                        "isolate_network", "restore_network",
                        "collect_diagnostics"
                    ]
                },
                "params": {
                    "type": "object",
                    "description": "Action-specific parameters (patch_id, script_content, software_id, etc.)"
                },
                "reason": {
                    "type": "string",
                    "description": "Why this action is being taken. Required for audit trail."
                }
            },
            "required": ["device_ids", "action", "reason"]
        }
    }
]
```

### Monitoring & Alerting Tools

```python
monitoring_tools = [
    {
        "name": "get_alerts",
        "description": "Retrieve active alerts across the environment. Alerts include severity, affected device, category, and recommended actions.",
        "input_schema": {
            "type": "object",
            "properties": {
                "tenant_id": {"type": "string"},
                "severity": {"enum": ["critical", "high", "medium", "low", "info"]},
                "category": {"enum": [
                    "security", "performance", "hardware",
                    "software", "compliance", "connectivity"
                ]},
                "status": {"enum": ["open", "acknowledged", "in_progress", "resolved"]},
                "since": {"type": "string", "format": "date-time"},
                "limit": {"type": "integer", "default": 50}
            },
            "required": ["tenant_id"]
        }
    },
    {
        "name": "update_alert",
        "description": "Update an alert's status, add notes, or link to a ticket.",
        "input_schema": {
            "type": "object",
            "properties": {
                "alert_id": {"type": "string"},
                "status": {"enum": ["acknowledged", "in_progress", "resolved", "false_positive"]},
                "notes": {"type": "string"},
                "ticket_id": {"type": "string"},
                "resolution": {"type": "string"}
            },
            "required": ["alert_id"]
        }
    },
    {
        "name": "get_event_stream",
        "description": "Get recent events/telemetry for a tenant or device. Events are structured logs of everything happening in the environment.",
        "input_schema": {
            "type": "object",
            "properties": {
                "tenant_id": {"type": "string"},
                "device_id": {"type": "string"},
                "event_types": {
                    "type": "array",
                    "items": {"enum": [
                        "login_success", "login_failure",
                        "software_installed", "software_removed",
                        "patch_applied", "patch_failed",
                        "policy_violation", "policy_applied",
                        "performance_threshold", "disk_warning",
                        "service_stopped", "service_started",
                        "network_change", "security_event",
                        "user_action", "agent_action"
                    ]}
                },
                "since": {"type": "string", "format": "date-time"},
                "limit": {"type": "integer", "default": 100}
            },
            "required": ["tenant_id"]
        }
    }
]
```

### Patch Management Tools

```python
patch_tools = [
    {
        "name": "get_patch_status",
        "description": "Get patch compliance status across devices. Shows missing patches, pending installs, and failed patches.",
        "input_schema": {
            "type": "object",
            "properties": {
                "tenant_id": {"type": "string"},
                "device_id": {"type": "string"},
                "severity_filter": {"enum": ["critical", "important", "moderate", "low"]},
                "status_filter": {"enum": ["missing", "pending", "installed", "failed"]}
            },
            "required": ["tenant_id"]
        }
    },
    {
        "name": "deploy_patches",
        "description": "Deploy patches to devices. Supports immediate or scheduled deployment with maintenance windows.",
        "input_schema": {
            "type": "object",
            "properties": {
                "device_ids": {"type": "array", "items": {"type": "string"}},
                "patch_ids": {"type": "array", "items": {"type": "string"}},
                "schedule": {
                    "type": "object",
                    "properties": {
                        "type": {"enum": ["immediate", "maintenance_window", "scheduled"]},
                        "datetime": {"type": "string", "format": "date-time"},
                        "reboot_policy": {"enum": ["auto", "defer", "force", "user_prompt"]}
                    }
                },
                "reason": {"type": "string"}
            },
            "required": ["device_ids", "patch_ids", "reason"]
        }
    }
]
```

### Scripting & Automation Tools

```python
scripting_tools = [
    {
        "name": "run_script",
        "description": "Execute a script on one or more devices. Supports PowerShell, Bash, Python. Returns stdout, stderr, exit code.",
        "input_schema": {
            "type": "object",
            "properties": {
                "device_ids": {"type": "array", "items": {"type": "string"}},
                "language": {"enum": ["powershell", "bash", "python", "cmd"]},
                "script": {"type": "string", "description": "Script content to execute"},
                "timeout_seconds": {"type": "integer", "default": 300},
                "run_as": {"enum": ["system", "current_user", "admin"]},
                "reason": {"type": "string"}
            },
            "required": ["device_ids", "language", "script", "reason"]
        }
    },
    {
        "name": "get_script_result",
        "description": "Get the result of a previously executed script.",
        "input_schema": {
            "type": "object",
            "properties": {
                "execution_id": {"type": "string"}
            },
            "required": ["execution_id"]
        }
    }
]
```

### Reporting & Documentation Tools

```python
reporting_tools = [
    {
        "name": "generate_report",
        "description": "Generate a report for a tenant. Reports can cover compliance, inventory, security posture, patch status, etc.",
        "input_schema": {
            "type": "object",
            "properties": {
                "tenant_id": {"type": "string"},
                "report_type": {"enum": [
                    "compliance_summary", "security_posture",
                    "patch_compliance", "hardware_inventory",
                    "software_inventory", "incident_summary",
                    "executive_summary", "custom"
                ]},
                "date_range": {
                    "type": "object",
                    "properties": {
                        "start": {"type": "string", "format": "date"},
                        "end": {"type": "string", "format": "date"}
                    }
                },
                "format": {"enum": ["json", "markdown", "pdf", "html"]}
            },
            "required": ["tenant_id", "report_type"]
        }
    },
    {
        "name": "log_documentation",
        "description": "Create or update documentation for a tenant, device, or procedure. Maintains an audit trail of all changes.",
        "input_schema": {
            "type": "object",
            "properties": {
                "tenant_id": {"type": "string"},
                "doc_type": {"enum": ["runbook", "incident_note", "change_log", "client_note", "procedure"]},
                "title": {"type": "string"},
                "content": {"type": "string"},
                "related_device_ids": {"type": "array", "items": {"type": "string"}},
                "related_alert_ids": {"type": "array", "items": {"type": "string"}}
            },
            "required": ["tenant_id", "doc_type", "title", "content"]
        }
    }
]
```

---

## The Risk/Approval Layer (Critical Safety Mechanism)

This is what separates a toy from a production system. Every action has a
risk classification. The brain connector enforces this regardless of whether
the caller is BYOK or LanternOps.

```python
# Built into the open source RMM — not bypassable by the brain layer

RISK_CLASSIFICATIONS = {
    # AUTO-EXECUTE: Agent can do these without human approval
    "low": [
        "list_devices",
        "get_device_details",
        "get_alerts",
        "get_event_stream",
        "get_patch_status",
        "get_script_result",
        "generate_report",
        "collect_diagnostics",
        "update_alert",          # status changes only
    ],

    # NOTIFY: Agent executes but notifies the MSP tech
    "medium": [
        "run_script",            # read-only scripts only
        "deploy_patches",        # pre-approved patch lists only
        "install_software",      # from approved software catalog
        "reboot",                # during maintenance window
        "enable_firewall",
        "log_documentation",
    ],

    # REQUIRE APPROVAL: Agent proposes, human confirms
    "high": [
        "run_script",            # scripts that modify state
        "deploy_patches",        # outside maintenance window
        "uninstall_software",
        "reboot",                # outside maintenance window
        "shutdown",
        "isolate_network",
        "disable_firewall",
    ],

    # ALWAYS BLOCKED FROM AGENT: Human must do these manually
    "critical": [
        "wipe",
        "restore_network",       # after isolation — human verifies threat resolved
        # bulk operations above N devices (configurable threshold)
    ]
}
```

### Approval Flow

```
Agent decides action is needed
        │
        ▼
Risk classification check (enforced by RMM, not the brain)
        │
        ├── LOW ──────► Execute immediately, log it
        │
        ├── MEDIUM ───► Execute, send notification to tech
        │                (Slack, email, dashboard alert)
        │
        ├── HIGH ─────► Create approval request
        │                ├── Tech approves → Execute
        │                ├── Tech modifies → Execute modified
        │                └── Tech denies → Log and learn
        │
        └── CRITICAL ─► Block entirely. Surface in dashboard
                         for manual execution.
```

---

## Event System (RMM → Brain)

The RMM pushes events that trigger the brain to think and potentially act.

```python
# Standard event envelope — every event from the RMM follows this shape

class RMMEvent:
    event_id: str           # unique identifier
    event_type: str         # from the event_types enum above
    timestamp: datetime
    tenant_id: str
    device_id: str | None
    severity: str           # critical, high, medium, low, info
    category: str           # security, performance, compliance, etc.
    summary: str            # human-readable one-liner
    details: dict           # event-type-specific payload
    related_events: list    # IDs of correlated events
    suggested_actions: list # RMM's built-in suggestions (optional)


# Example events the RMM emits:

{
    "event_type": "security_event",
    "severity": "critical",
    "summary": "Brute force login detected on ACME-DC01",
    "details": {
        "sub_type": "brute_force_detected",
        "source_ips": ["192.168.1.45", "10.0.0.12"],
        "target_account": "administrator",
        "failed_attempts": 47,
        "time_window_minutes": 5,
        "device_role": "domain_controller"
    },
    "suggested_actions": ["isolate_network", "collect_diagnostics"]
}

{
    "event_type": "patch_failed",
    "severity": "high",
    "summary": "KB5034441 failed on 12 devices across 3 tenants",
    "details": {
        "patch_id": "KB5034441",
        "affected_devices": ["dev-001", "dev-002", ...],
        "error_code": "0x80070643",
        "error_detail": "Recovery partition too small",
        "affected_tenant_ids": ["tenant-a", "tenant-b", "tenant-c"]
    }
}

{
    "event_type": "performance_threshold",
    "severity": "medium",
    "summary": "ACME-WS05 disk usage at 94%",
    "details": {
        "metric": "disk_usage_percent",
        "current_value": 94,
        "threshold": 90,
        "drive": "C:",
        "total_gb": 256,
        "free_gb": 15.4,
        "trend": "increasing",
        "days_until_full_estimate": 12
    }
}
```

---

## BYOK Mode vs LanternOps Mode

### BYOK Mode (Ships with open source RMM)

```python
# Simple single-agent loop. Runs locally. User's own API key.
# Good enough to be useful, limited enough to upsell.

import anthropic

client = anthropic.Anthropic(api_key=user_provided_key)

def byok_agent_loop(event: RMMEvent):
    """Basic reactive agent. Handles one event at a time."""

    response = client.messages.create(
        model="claude-sonnet-4-5-20250929",
        max_tokens=4096,
        system="""You are an IT management assistant for an MSP.
        You have access to RMM tools to investigate and resolve issues.
        Always explain what you're doing and why.
        For high-risk actions, present your plan and wait for approval.""",
        tools=all_rmm_tools,  # The tool definitions above
        messages=[
            {
                "role": "user",
                "content": f"New event received:\n{event.to_json()}\n\nInvestigate and recommend or take appropriate action."
            }
        ]
    )

    # Standard tool-use loop
    while response.stop_reason == "tool_use":
        tool_results = execute_tool_calls(response, risk_checker)
        response = client.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=4096,
            system=system_prompt,
            tools=all_rmm_tools,
            messages=[...previous_messages, tool_results]
        )

    return response

# BYOK Limitations (by design):
# - No memory between events (no persistent context)
# - No cross-tenant pattern matching
# - No playbook library (just raw reasoning)
# - No background analysis or proactive scanning
# - No optimized token usage (every call is full context)
# - No escalation routing to the right tech
# - Basic risk classification only
```

### LanternOps Mode (Commercial Brain)

```python
# This is the sketch of what LanternOps adds on top.
# Multi-agent orchestration with persistent memory,
# cross-tenant intelligence, and sophisticated workflows.

from anthropic import Agent, tool

class LanternOpsOrchestrator:
    """
    The commercial brain. Connects to one or more RMM instances.
    Runs in LanternOps cloud. This is where the real value lives.
    """

    def __init__(self, tenant_config):
        self.memory = TenantMemoryStore(tenant_config)
        self.playbooks = PlaybookEngine()
        self.cross_tenant = CrossTenantIntelligence()
        self.approval_router = ApprovalRouter(tenant_config)

    # ── TRIAGE AGENT ──────────────────────────────────
    # First responder. Classifies, correlates, decides routing.

    triage_agent = Agent(
        name="triage",
        model="claude-sonnet-4-5-20250929",
        instructions="""You are the triage agent for an MSP's managed
        environment. Your job:
        1. Classify incoming events by urgency and category
        2. Check memory for related recent events or known issues
        3. Correlate with cross-tenant intelligence
        4. Route to the appropriate specialist agent or playbook
        5. If this is a known pattern, invoke the relevant playbook
        6. If novel, investigate and build a response plan""",
        tools=[
            # RMM tools (from the open source layer)
            *all_rmm_tools,
            # LanternOps-specific tools (the commercial value)
            query_tenant_memory,
            check_cross_tenant_patterns,
            invoke_playbook,
            route_to_specialist,
            create_approval_request,
            escalate_to_human,
        ]
    )

    # ── REMEDIATION AGENT ─────────────────────────────
    # Takes action. Executes fixes. Validates results.

    remediation_agent = Agent(
        name="remediation",
        model="claude-sonnet-4-5-20250929",
        instructions="""You are the remediation specialist. You receive
        a diagnosed issue with a proposed fix. Your job:
        1. Validate the diagnosis is correct
        2. Check for any risks or dependencies
        3. Execute the remediation steps
        4. Verify the fix worked
        5. Document what was done and why
        6. Update tenant memory with the resolution""",
        tools=[
            *all_rmm_tools,
            update_tenant_memory,
            log_resolution,
            verify_remediation,
        ]
    )

    # ── COMPLIANCE AGENT ──────────────────────────────
    # Continuous compliance monitoring and evidence generation.
    # (This is LanternOps's existing sweet spot)

    compliance_agent = Agent(
        name="compliance",
        model="claude-sonnet-4-5-20250929",
        instructions="""You monitor compliance posture continuously.
        Your job:
        1. Evaluate device state against compliance frameworks
        2. Generate evidence artifacts automatically
        3. Flag compliance drift before it becomes a violation
        4. Produce client-ready compliance reports""",
        tools=[
            *all_rmm_tools,
            evaluate_compliance_framework,
            generate_evidence_artifact,
            get_compliance_requirements,  # NIST, CIS, SOC2, HIPAA, etc.
        ]
    )

    # ── ORCHESTRATION LOOP ────────────────────────────

    async def process_event(self, event: RMMEvent):
        """
        Main orchestration loop. This is the core of LanternOps.
        """

        # 1. Enrich event with memory and cross-tenant context
        context = await self.build_context(event)

        # 2. Check if a playbook matches this event pattern
        playbook = self.playbooks.match(event, context)

        if playbook:
            # Known pattern → execute playbook
            # (Playbooks are the accumulated operational knowledge)
            result = await playbook.execute(
                event=event,
                context=context,
                agents={"remediation": self.remediation_agent},
                approval_router=self.approval_router
            )
        else:
            # Novel situation → triage agent investigates
            result = await self.triage_agent.run(
                f"""New event requires investigation:

                Event: {event.to_json()}

                Tenant Memory Context:
                {context.tenant_history}

                Cross-Tenant Intelligence:
                {context.cross_tenant_patterns}

                Investigate and determine the best course of action."""
            )

        # 3. Update memory with what happened
        await self.memory.record(event, result)

        # 4. Feed anonymized patterns to cross-tenant intelligence
        await self.cross_tenant.learn(event, result)

        return result

    async def build_context(self, event):
        """
        This is a huge part of the commercial value.
        BYOK can't do any of this.
        """
        return EventContext(
            # What's happened recently on this device/tenant?
            tenant_history=await self.memory.get_relevant(
                tenant_id=event.tenant_id,
                device_id=event.device_id,
                event_type=event.event_type
            ),
            # Have we seen this pattern across other tenants?
            cross_tenant_patterns=await self.cross_tenant.query(
                event_type=event.event_type,
                details=event.details
            ),
            # What's the device's full context?
            device_profile=await self.memory.get_device_profile(
                event.device_id
            ),
            # What compliance frameworks apply?
            compliance_requirements=await self.memory.get_compliance_reqs(
                event.tenant_id
            ),
        )


# ── LANTERNOPS-ONLY TOOLS ─────────────────────────────
# These tools are NOT in the open source RMM.
# They're the commercial brain's capabilities.

@tool
def query_tenant_memory(tenant_id: str, query: str) -> dict:
    """Search the persistent memory for a tenant.
    Remembers past incidents, resolutions, device quirks,
    client preferences, and operational patterns."""
    ...

@tool
def check_cross_tenant_patterns(event_signature: dict) -> dict:
    """Check if this event pattern has been seen across other
    managed tenants (anonymized). Returns known resolutions,
    success rates, and warnings."""
    ...

@tool
def invoke_playbook(playbook_id: str, params: dict) -> dict:
    """Execute a pre-built operational playbook. Playbooks are
    multi-step workflows built from successful past resolutions.
    They encode MSP operational best practices."""
    ...

@tool
def evaluate_compliance_framework(
    tenant_id: str,
    framework: str,  # "nist_800_171", "cis_v8", "soc2", "hipaa"
    scope: str = "full"
) -> dict:
    """Evaluate current environment state against a compliance
    framework. Returns compliance score, gaps, and evidence."""
    ...

@tool
def generate_evidence_artifact(
    tenant_id: str,
    control_id: str,
    artifact_type: str  # "screenshot", "config_dump", "log_export", "report"
) -> dict:
    """Generate a compliance evidence artifact for a specific
    control. Automatically formatted for auditor consumption."""
    ...
```

---

## Example: Full Event Flow

```
1. RMM detects: "KB5034441 failed on ACME-WS05, error 0x80070643"

2. Event emitted to brain connector

3a. BYOK Mode:
    → Agent sees event
    → Calls get_device_details(device_id="acme-ws05")
    → Reasons about error code
    → Suggests: "Recovery partition is too small. Run this
       PowerShell script to extend it, then retry the patch."
    → Presents script for approval
    → Tech approves
    → Runs script, retries patch
    → Done. No memory of this for next time.

3b. LanternOps Mode:
    → Triage agent sees event
    → Checks cross-tenant intelligence: "This error seen on 847
       devices across 62 tenants this month. Known fix: extend
       recovery partition. Success rate: 94%."
    → Checks tenant memory: "ACME-WS05 had a similar patch
       failure 3 months ago. Different KB but same root cause.
       Recovery partition was extended then but only by 100MB."
    → Matches to playbook: "KB_PATCH_FAILURE_RECOVERY_PARTITION"
    → Playbook executes:
       1. Checks current partition size (run_script, read-only)
       2. Determines correct extension size
       3. Extends partition (run_script, approved via playbook policy)
       4. Retries patch deployment
       5. Verifies success
       6. Checks: are other ACME devices likely to hit this?
       7. Pre-emptively fixes 3 other ACME devices
       8. Updates compliance evidence for ACME
       9. Logs resolution to tenant memory
       10. Sends tech a summary: "Fixed KB5034441 on 4 ACME
           devices. Recovery partition issue. All patched."
    → Total tech time: 10 seconds reading the summary
```

---

## What Ships Where

### Open Source RMM
- Device agent (endpoint software)
- Device management, monitoring, alerting
- Patch management engine
- Script execution engine
- Remote access
- Basic dashboard/UI
- Brain connector interface
- Risk classification enforcement
- Tool definitions (the API contract)
- BYOK agent loop (basic single-agent)
- Event emission system

### LanternOps Commercial (the Brain)
- Multi-agent orchestration
- Persistent tenant memory
- Cross-tenant intelligence engine
- Playbook library + builder
- Compliance framework evaluations
- Evidence artifact generation
- Approval routing + escalation
- Client-facing report generation
- Proactive scanning + recommendations
- Token optimization + caching
- SLA monitoring + alerting
- Tech performance analytics
- Onboarding automation (new client setup)

---

## Key Design Principles

1. **The tool definitions are the contract.** If you change a tool's
   schema, that's a breaking change. Version them.

2. **Risk enforcement lives in the RMM, not the brain.** The open
   source layer NEVER trusts the brain to self-regulate. The RMM
   validates every action against risk classification before executing.

3. **The brain connector is pluggable.** LanternOps is the best brain,
   but the architecture allows others. This is what makes open source
   credible — the MSP isn't locked into your commercial product.

4. **Events are the trigger, tools are the interface.** The brain
   doesn't poll. The RMM pushes events. The brain responds by
   calling tools. Clean separation.

5. **Every action is auditable.** Whether BYOK or LanternOps, every
   tool call, every decision, every approval is logged. MSPs live
   and die by their audit trail.
