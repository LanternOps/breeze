# Brain Connector Deep Dive
## How the Claude Agent SDK Bridges LanternOps ↔ Open Source RMM

---

## The Core Insight

The Agent SDK runs **inside LanternOps** (your cloud). The tools it
calls are **HTTP calls to the RMM** (customer's infrastructure). The
tool functions are thin wrappers that translate "agent wants to do X"
into "call the RMM's API to do X."

The agent SDK is self-contained in that it decides WHEN to call tools.
But you control WHAT those tools actually do under the hood. And what
they do is call a remote API.

```
┌─ LanternOps Cloud ─────────────────────────────┐
│                                                 │
│   Agent SDK                                     │
│   ┌─────────────────────────────────┐           │
│   │ Claude Agent                    │           │
│   │                                 │           │
│   │ "I should check device status"  │           │
│   │        │                        │           │
│   │        ▼                        │           │
│   │  calls list_devices() tool      │           │
│   └────────┬────────────────────────┘           │
│            │                                    │
│            ▼                                    │
│   Tool function: list_devices()                 │
│   ┌─────────────────────────────────┐           │
│   │ async def list_devices(...)     │           │
│   │   # NOT local logic!           │           │
│   │   # This is an HTTP call       │           │
│   │   response = await rmm_client  │           │
│   │     .post("/api/v1/devices",   │           │
│   │       tenant_id=...,           │           │
│   │       filters=...)             │           │
│   │   return response.json()       │           │
│   └────────┬────────────────────────┘           │
│            │                                    │
└────────────┼────────────────────────────────────┘
             │ HTTPS (authenticated, encrypted)
             │
┌────────────┼────────────────────────────────────┐
│  Open Source RMM (Customer's Infrastructure)    │
│            │                                    │
│   ┌────────▼────────────────────────────┐       │
│   │    Brain Connector API Server       │       │
│   │    /api/v1/devices                  │       │
│   │    /api/v1/alerts                   │       │
│   │    /api/v1/execute                  │       │
│   │    /api/v1/scripts                  │       │
│   │                                     │       │
│   │    ┌─────────────────────────┐      │       │
│   │    │   Risk Validator        │      │       │
│   │    │   (ALWAYS enforced)     │      │       │
│   │    └─────────────────────────┘      │       │
│   └─────────────────────────────────────┘       │
│            │                                    │
│   ┌────────▼────────────────────────────┐       │
│   │    RMM Core (devices, agents, etc)  │       │
│   └─────────────────────────────────────┘       │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## Two Modes, Same Tool Schemas, Different Wiring

The genius is that the TOOL DEFINITIONS are identical in both modes.
The agent sees the same tools regardless. What changes is where
those tools execute.

### BYOK Mode: Everything Local

```python
# ── BYOK: runs entirely inside the open source RMM ──────────

import anthropic

# Tools call local functions directly. No network hop.

def list_devices_local(tenant_id: str, filters: dict = None) -> dict:
    """Directly queries the local RMM database."""
    devices = db.query(Device).filter_by(tenant_id=tenant_id)
    if filters:
        devices = apply_filters(devices, filters)
    return {"devices": [d.to_dict() for d in devices]}


def execute_action_local(device_ids: list, action: str, reason: str, params: dict = None) -> dict:
    """Executes directly against local RMM engine, with risk check."""

    # Risk validation happens HERE, locally
    risk_level = classify_risk(action, params, device_ids)
    if risk_level == "critical":
        return {"status": "blocked", "reason": "Action requires manual execution"}
    if risk_level == "high":
        approval_id = create_local_approval_request(action, device_ids, reason)
        return {"status": "pending_approval", "approval_id": approval_id}

    # Execute
    result = rmm_engine.execute(device_ids, action, params)
    audit_log.record(action, device_ids, reason, result, actor="byok_agent")
    return result


# The BYOK agent loop — simple, self-contained
def run_byok_agent(event):
    client = anthropic.Anthropic(api_key=config.user_api_key)

    # Tool definitions are the same schemas from the architecture doc
    # But they're wired to the _local functions above
    tools = [
        {
            "name": "list_devices",
            "description": "List managed devices...",
            "input_schema": { ... },
            # Internal wiring (not part of the schema):
            "_handler": list_devices_local
        },
        {
            "name": "execute_action",
            "description": "Execute a management action...",
            "input_schema": { ... },
            "_handler": execute_action_local
        },
        # ... all other tools, wired to local handlers
    ]

    # Standard agent loop
    messages = [{"role": "user", "content": f"Event: {event.to_json()}"}]

    response = client.messages.create(
        model="claude-sonnet-4-5-20250929",
        system="You are an IT management assistant...",
        tools=[t for t in tools],  # schema only, no handler
        messages=messages
    )

    while response.stop_reason == "tool_use":
        tool_calls = [b for b in response.content if b.type == "tool_use"]
        tool_results = []

        for call in tool_calls:
            handler = next(t["_handler"] for t in tools if t["name"] == call.name)
            result = handler(**call.input)
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": call.id,
                "content": json.dumps(result)
            })

        messages.append({"role": "assistant", "content": response.content})
        messages.append({"role": "user", "content": tool_results})

        response = client.messages.create(
            model="claude-sonnet-4-5-20250929",
            system="You are an IT management assistant...",
            tools=[t for t in tools],
            messages=messages
        )

    return response
```

### LanternOps Mode: Agent in Cloud, Tools Call RMM Remotely

```python
# ── LANTERNOPS: Agent runs in cloud, tools are remote calls ──

# This runs in LanternOps cloud infrastructure.
# The RMM is a remote system accessed via authenticated API.

class RMMClient:
    """
    HTTP client that talks to a customer's RMM brain connector.
    Each customer's RMM registers with LanternOps and gets
    a secure tunnel/webhook endpoint.
    """

    def __init__(self, rmm_endpoint: str, auth_token: str):
        self.endpoint = rmm_endpoint  # e.g. "https://rmm.acme-msp.com/api/v1"
        self.auth_token = auth_token
        self.session = httpx.AsyncClient(
            headers={"Authorization": f"Bearer {auth_token}"},
            timeout=30.0
        )

    async def call(self, path: str, payload: dict) -> dict:
        """Make an authenticated call to the customer's RMM."""
        response = await self.session.post(
            f"{self.endpoint}{path}",
            json=payload
        )
        response.raise_for_status()
        return response.json()


# ── Tool functions that the Agent SDK calls ──────────────────
# These look like local functions to the agent.
# Under the hood, they're HTTP calls to the customer's RMM.

class LanternOpsTools:
    """
    Tools provided to the Claude Agent SDK.
    Each tool is a thin wrapper around an RMM API call,
    with LanternOps-specific enrichment.
    """

    def __init__(self, rmm_client: RMMClient, memory: TenantMemory):
        self.rmm = rmm_client
        self.memory = memory

    async def list_devices(self, tenant_id: str, filters: dict = None,
                           include_details: list = None) -> dict:
        """
        The agent calls this like any other tool.
        It doesn't know or care that it's an HTTP call.
        """
        # Call the remote RMM
        result = await self.rmm.call("/devices/list", {
            "tenant_id": tenant_id,
            "filters": filters,
            "include_details": include_details
        })

        # LanternOps enrichment — stuff BYOK can't do
        for device in result["devices"]:
            # Add memory context (past issues, quirks, notes)
            device["_lanternops_context"] = await self.memory.get_device_context(
                device["device_id"]
            )

        return result

    async def execute_action(self, device_ids: list, action: str,
                             reason: str, params: dict = None) -> dict:
        """
        Agent decides to take an action. LanternOps adds its own
        validation layer BEFORE sending to the RMM.
        """

        # LanternOps pre-validation (in addition to RMM's risk check)
        lanternops_check = await self.pre_validate(
            action=action,
            device_ids=device_ids,
            params=params,
            reason=reason
        )

        if not lanternops_check["approved"]:
            return {
                "status": "blocked_by_lanternops",
                "reason": lanternops_check["reason"],
                "suggestion": lanternops_check.get("alternative")
            }

        # Send to RMM — which does its OWN risk validation too
        result = await self.rmm.call("/actions/execute", {
            "device_ids": device_ids,
            "action": action,
            "params": params,
            "reason": reason,
            "requested_by": "lanternops_agent"
        })

        # Log to LanternOps memory
        await self.memory.record_action(
            action=action,
            device_ids=device_ids,
            result=result,
            reason=reason
        )

        return result

    async def pre_validate(self, action, device_ids, params, reason):
        """
        LanternOps's own safety layer. This is COMMERCIAL VALUE.

        Examples of what this catches that raw RMM risk classification won't:

        - "You're about to reboot 15 devices at 2pm on a Tuesday.
           Historical data shows ACME Corp has heavy usage until 5pm.
           Recommend scheduling for 10pm."

        - "This script was run on a similar device last week and
           caused a BSOD. Flagging for manual review."

        - "3 other tenants reported issues with this patch in the
           last 24 hours. Recommending hold."
        """

        # Check cross-tenant intelligence
        cross_tenant_risk = await self.cross_tenant.assess_risk(
            action, params
        )

        # Check tenant-specific patterns
        tenant_risk = await self.memory.assess_risk(
            action, device_ids, params
        )

        # Check timing/context
        timing_risk = await self.assess_timing(device_ids)

        if any_risk_flagged(cross_tenant_risk, tenant_risk, timing_risk):
            return {
                "approved": False,
                "reason": compile_risk_reasons(...),
                "alternative": suggest_alternative(...)
            }

        return {"approved": True}


# ── Wiring it up with the Agent SDK ──────────────────────────

from anthropic import Agent, tool

def create_lanternops_agent(rmm_client: RMMClient, tenant_config: dict):
    """
    Create a Claude Agent with tools wired to a specific
    customer's RMM instance.
    """

    tools = LanternOpsTools(
        rmm_client=rmm_client,
        memory=TenantMemory(tenant_config["tenant_id"])
    )

    # Define tools for the Agent SDK using the @tool decorator
    # These wrap the LanternOpsTools methods

    @tool
    async def list_devices(tenant_id: str, filters: dict = None,
                           include_details: list = None) -> dict:
        """List managed devices with optional filters. Returns device ID,
        hostname, OS, last seen, health status, compliance state,
        and LanternOps context from past interactions."""
        return await tools.list_devices(tenant_id, filters, include_details)

    @tool
    async def execute_action(device_ids: list, action: str, reason: str,
                             params: dict = None) -> dict:
        """Execute a management action on devices. Actions are validated
        against both LanternOps intelligence and RMM risk classification."""
        return await tools.execute_action(device_ids, action, reason, params)

    @tool
    async def get_alerts(tenant_id: str, severity: str = None,
                         category: str = None, status: str = None) -> dict:
        """Retrieve active alerts with LanternOps context."""
        return await tools.get_alerts(tenant_id, severity, category, status)

    @tool
    async def run_script(device_ids: list, language: str, script: str,
                         reason: str, run_as: str = "system") -> dict:
        """Execute a script on devices. Validated against known-bad
        patterns and cross-tenant incident history."""
        return await tools.run_script(device_ids, language, script, reason, run_as)

    # ... all other RMM tools wrapped the same way

    # PLUS LanternOps-only tools that don't exist in BYOK at all

    @tool
    async def query_memory(tenant_id: str, query: str) -> dict:
        """Search LanternOps memory for past incidents, resolutions,
        device quirks, and operational patterns for this tenant."""
        return await tools.memory.search(tenant_id, query)

    @tool
    async def check_cross_tenant(event_signature: dict) -> dict:
        """Check if this pattern has been seen across other tenants.
        Returns anonymized resolution data and success rates."""
        return await tools.cross_tenant.query(event_signature)

    @tool
    async def invoke_playbook(playbook_id: str, context: dict) -> dict:
        """Execute a validated operational playbook."""
        return await tools.playbooks.execute(playbook_id, context)

    # Create the agent
    agent = Agent(
        name="lanternops_triage",
        model="claude-sonnet-4-5-20250929",
        instructions=build_system_prompt(tenant_config),
        tools=[
            list_devices, execute_action, get_alerts, run_script,
            query_memory, check_cross_tenant, invoke_playbook,
            # ... all other tools
        ]
    )

    return agent
```

---

## The Brain Connector (Open Source RMM Side)

This is the API server that runs inside the open source RMM.
It receives calls from either BYOK (local) or LanternOps (remote).

```python
# ── brain_connector.py — Ships with the open source RMM ─────

from fastapi import FastAPI, Depends, HTTPException
from .risk_engine import RiskValidator
from .audit import AuditLog
from .rmm_core import RMMEngine

app = FastAPI(title="RMM Brain Connector", version="1.0")
risk_validator = RiskValidator()
audit = AuditLog()
rmm = RMMEngine()


# ── Authentication ───────────────────────────────────────────

async def authenticate_brain(request: Request) -> BrainSession:
    """
    Validates the caller. Could be:
    - LanternOps cloud (API key + mutual TLS)
    - BYOK local agent (local auth token)
    - Future: other brain providers
    """
    auth_header = request.headers.get("Authorization")
    brain_type = request.headers.get("X-Brain-Type", "unknown")

    session = await validate_credentials(auth_header, brain_type)
    if not session:
        raise HTTPException(401, "Invalid brain credentials")

    return session


# ── Device Endpoints ─────────────────────────────────────────

@app.post("/api/v1/devices/list")
async def list_devices(
    payload: DeviceListRequest,
    brain: BrainSession = Depends(authenticate_brain)
):
    """
    Both BYOK and LanternOps call this same endpoint.
    The RMM doesn't care who's asking — it validates and responds.
    """
    # Validate tenant access
    if not brain.has_tenant_access(payload.tenant_id):
        raise HTTPException(403, "No access to this tenant")

    devices = rmm.list_devices(
        tenant_id=payload.tenant_id,
        filters=payload.filters,
        include_details=payload.include_details
    )

    # Audit log
    audit.log(
        actor=brain.identity,
        action="list_devices",
        tenant_id=payload.tenant_id,
        details={"filter_count": len(payload.filters or {})}
    )

    return {"devices": devices}


# ── Action Execution (with risk enforcement) ─────────────────

@app.post("/api/v1/actions/execute")
async def execute_action(
    payload: ActionRequest,
    brain: BrainSession = Depends(authenticate_brain)
):
    """
    THIS IS WHERE RISK ENFORCEMENT HAPPENS.
    The brain (BYOK or LanternOps) can request anything.
    The RMM decides whether to allow it.
    """

    # Step 1: Classify risk
    risk = risk_validator.classify(
        action=payload.action,
        device_ids=payload.device_ids,
        params=payload.params,
        brain_type=brain.brain_type,
        time_of_day=datetime.now(),
        # Custom risk rules set by MSP admin
        custom_rules=get_custom_risk_rules(brain.msp_id)
    )

    # Step 2: Enforce based on risk level
    if risk.level == "critical":
        audit.log(
            actor=brain.identity,
            action="execute_action_BLOCKED",
            details={"action": payload.action, "reason": "critical_risk"}
        )
        return {
            "status": "blocked",
            "risk_level": "critical",
            "reason": "This action requires manual execution via the RMM dashboard.",
            "dashboard_link": f"/actions/manual?action={payload.action}"
        }

    if risk.level == "high":
        approval = create_approval_request(
            action=payload.action,
            device_ids=payload.device_ids,
            params=payload.params,
            reason=payload.reason,
            requested_by=brain.identity,
            risk_details=risk.details
        )
        # Notify MSP tech via configured channels
        await notify_approval_needed(approval)

        return {
            "status": "pending_approval",
            "approval_id": approval.id,
            "risk_level": "high",
            "risk_details": risk.details,
            "approval_link": f"/approvals/{approval.id}"
        }

    if risk.level == "medium":
        # Execute but notify
        result = rmm.execute(
            device_ids=payload.device_ids,
            action=payload.action,
            params=payload.params
        )
        await notify_action_taken(brain.identity, payload, result)

        audit.log(
            actor=brain.identity,
            action="execute_action",
            risk_level="medium",
            details={"action": payload.action, "result": result["status"]}
        )
        return result

    # Low risk — just do it
    result = rmm.execute(
        device_ids=payload.device_ids,
        action=payload.action,
        params=payload.params
    )

    audit.log(
        actor=brain.identity,
        action="execute_action",
        risk_level="low",
        details={"action": payload.action, "result": result["status"]}
    )
    return result


# ── Event Stream (RMM → Brain) ───────────────────────────────

@app.websocket("/api/v1/events/stream")
async def event_stream(
    websocket: WebSocket,
    brain: BrainSession = Depends(authenticate_brain)
):
    """
    Real-time event stream from RMM to brain.

    BYOK mode: connects locally, gets events for all tenants
    LanternOps mode: connects from cloud, gets events for
    all tenants this MSP manages through LanternOps
    """
    await websocket.accept()

    async for event in rmm.event_bus.subscribe(
        tenant_ids=brain.authorized_tenants
    ):
        await websocket.send_json(event.to_dict())


# ── Approval Callback (Brain checks if approval was granted) ──

@app.get("/api/v1/approvals/{approval_id}")
async def check_approval(
    approval_id: str,
    brain: BrainSession = Depends(authenticate_brain)
):
    """
    Brain polls this to check if a human approved the action.
    When approved, the brain can re-submit the action.
    """
    approval = get_approval(approval_id)
    return {
        "status": approval.status,  # pending, approved, denied, modified
        "approved_by": approval.approved_by,
        "modifications": approval.modifications,  # tech may have tweaked params
        "approved_at": approval.approved_at
    }


# ── Registration / Connection Setup ──────────────────────────

@app.post("/api/v1/brain/register")
async def register_brain(payload: BrainRegistration):
    """
    Called once when connecting a brain to this RMM.

    For BYOK: happens during setup wizard
    For LanternOps: happens when MSP connects their RMM
    to their LanternOps account

    Returns the available tool catalog so the brain knows
    what this RMM instance supports.
    """
    brain_session = await create_brain_session(
        brain_type=payload.brain_type,  # "byok" or "lanternops"
        credentials=payload.credentials,
        authorized_tenants=payload.tenant_ids
    )

    return {
        "session_token": brain_session.token,
        "tool_catalog": get_tool_catalog(),  # all available tool schemas
        "risk_policy": get_risk_policy(),     # current risk classifications
        "rmm_version": get_rmm_version(),
        "capabilities": get_capabilities(),   # what this RMM instance supports
    }
```

---

## The Connection Flow

### BYOK Setup
```
1. MSP installs open source RMM
2. Goes to Settings → AI Brain → BYOK
3. Enters Anthropic API key
4. RMM starts local agent loop
5. Agent uses tools that call LOCAL functions
6. Everything runs on MSP's own infrastructure
7. MSP pays Anthropic directly for API usage
```

### LanternOps Setup
```
1. MSP installs open source RMM
2. Goes to Settings → AI Brain → LanternOps
3. Clicks "Connect to LanternOps"
4. Redirects to LanternOps signup/login (OAuth flow)
5. MSP authorizes LanternOps to connect to their RMM
6. RMM calls /brain/register with LanternOps credentials
7. LanternOps receives tool catalog + establishes event stream
8. LanternOps agent starts monitoring via WebSocket
9. Tool calls flow over HTTPS from LanternOps → RMM
10. MSP pays LanternOps monthly subscription
```

### What the MSP admin sees:

```
┌─────────────────────────────────────────────────┐
│  Settings → AI Brain                            │
│                                                 │
│  Current Brain: ● LanternOps (Connected)        │
│                                                 │
│  ┌─────────┐  ┌──────────────┐                  │
│  │  BYOK   │  │ LanternOps ✓ │                  │
│  │         │  │              │                  │
│  │ Use your│  │ Managed AI   │                  │
│  │ own API │  │ operations   │                  │
│  │ key     │  │ platform     │                  │
│  └─────────┘  └──────────────┘                  │
│                                                 │
│  Connection Status: ● Active                    │
│  Events Processed (24h): 1,247                  │
│  Actions Taken (24h): 23                        │
│  Actions Pending Approval: 2                    │
│  Risk Policy: Standard (customize →)            │
│                                                 │
│  [Disconnect] [View Audit Log] [Risk Settings]  │
└─────────────────────────────────────────────────┘
```

---

## Why This Architecture Works

1. **Agent SDK doesn't need to be "outside the app"** — it runs in
   LanternOps's cloud. The tools are just HTTP calls. From the
   agent's perspective, it's calling functions. It doesn't know
   those functions are making network requests to a remote RMM.

2. **Same tool schemas, different wiring.** BYOK tools call local
   functions. LanternOps tools call remote APIs. The agent code
   and behavior is identical — only the plumbing changes.

3. **Double risk validation.** LanternOps pre-validates with its
   intelligence layer. The RMM re-validates with its risk engine.
   Belt AND suspenders. This is the "we take the AI risk" value prop.

4. **The RMM is sovereign.** The MSP's RMM is always the final
   authority on what executes. LanternOps can request, but the
   RMM can refuse. This is critical for trust.

5. **Clean upgrade path.** MSP starts with BYOK, sees value,
   hits limitations (no memory, no cross-tenant, no playbooks),
   switches to LanternOps. Same RMM, same tools, better brain.
   Zero migration.
