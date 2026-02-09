# Brain Connector & LanternOps Implementation Roadmap

## Decisions

| Decision | Answer |
|----------|--------|
| **Cloud provider** | DigitalOcean (cloud-agnostic design, no vendor lock-in) |
| **Agent SDK** | Claude Agent SDK (Python + TypeScript). Can call 3rd-party APIs as tools. |
| **Pricing model** | Per-device initially. Per-action tracking added later. |
| **Data residency** | Same cloud for both RMM and LanternOps. Cloud-agnostic design. |
| **Model support** | Anthropic models only (sonnet/opus/haiku). Agent SDK is Anthropic-native. Tool schemas are standard JSON Schema — other providers possible later via separate agent loop, not a priority. |
| **Existing AI code** | Retrofit `ai.ts` routes + schema into a single brain connector engine. No separate "chat" feature — everything goes through the brain. |

## Current State

Breeze RMM is a **feature-complete open-source RMM platform**. The core platform (monitoring, patching, remote access, scripting, alerting, discovery, backup, RBAC, SSO, audit logging) is built and functional.

An initial AI integration exists (`ai.ts` routes, `aiSessions`/`aiMessages`/`aiToolExecutions` schema) providing session-based Claude chat with tool execution and cost tracking. **This will be retrofitted into the brain connector** — not maintained as a separate feature.

**The gap**: Transforming from "chat with AI about your devices" into "AI autonomously triages events and takes validated actions" — the brain connector architecture described in the deep-dive docs.

---

## Roadmap Phases

### Phase 1: Brain Connector Foundation (RMM Side)
**Priority: HIGHEST — This is the open-source contract that everything else builds on**

The brain connector is the API surface that both BYOK and LanternOps consume. It must ship with the open-source RMM. Nothing else works without it.

#### 1.0 Retrofit Existing AI Code
- [ ] Migrate `ai.ts` routes into `apps/api/src/brain/` module
- [ ] Refactor `aiSessions`/`aiMessages`/`aiToolExecutions` schema to serve as brain connector tables
- [ ] Rename/restructure: AI chat becomes "brain interactive mode" (same UI, brain engine underneath)
- [ ] `aiCostUsage` + `aiBudgets` become the per-device cost tracking foundation
- [ ] Ensure existing chat UX continues to work through the new brain engine

**Why zero**: Don't build new alongside old. Consolidate first so there's one engine, one schema, one cost tracker.

#### 1.1 Tool Catalog Registry
- [ ] Define canonical tool schemas (JSON Schema format) for all RMM capabilities
- [ ] Store tool catalog in `apps/api/src/brain/tools/` with one file per tool group:
  - `device-tools.ts` — `list_devices`, `get_device_details`
  - `action-tools.ts` — `execute_action` (reboot, shutdown, lock, isolate, etc.)
  - `alert-tools.ts` — `get_alerts`, `update_alert`
  - `event-tools.ts` — `get_event_stream`
  - `patch-tools.ts` — `get_patch_status`, `deploy_patches`
  - `script-tools.ts` — `run_script`, `get_script_result`
  - `report-tools.ts` — `generate_report`, `log_documentation`
- [ ] `GET /api/v1/brain/catalog` — returns all tool schemas + RMM capabilities
- [ ] Versioning strategy for tool schemas (semver, backward compat)

**Why first**: The tool catalog IS the API contract. Both BYOK and LanternOps are consumers of it. Changing it later is a breaking change.

#### 1.2 Risk Classification Engine
- [ ] `apps/api/src/brain/risk/` — risk classification module
- [ ] Default risk classifications (from architecture doc):
  - **Low**: read-only tools (list, get, report, diagnostics)
  - **Medium**: guarded mutations (approved scripts, approved patches, maintenance-window reboots)
  - **High**: state-changing actions (modify scripts, off-window patches, shutdown, isolate)
  - **Critical**: destructive actions (wipe, bulk operations above threshold)
- [ ] Risk classification is context-aware:
  - Same action can be Medium (during maintenance window) or High (outside it)
  - Bulk threshold: configurable per-org (default: >5 devices = escalate one level)
- [ ] MSP admin UI for customizing risk rules per org
- [ ] DB schema: `riskPolicies` table (org-scoped overrides)

**Why second**: Risk enforcement is the safety mechanism. It must be enforced at the RMM level, not the brain level. This is non-negotiable for production use.

#### 1.3 Approval Workflow Engine
- [ ] DB schema: `brainApprovals` table (action, devices, risk level, status, approver, modifications)
- [ ] `POST /api/v1/brain/approvals` — create approval request
- [ ] `GET /api/v1/brain/approvals/:id` — check approval status
- [ ] `POST /api/v1/brain/approvals/:id/respond` — approve/deny/modify
- [ ] Notification dispatch on approval request (Slack, email, dashboard)
- [ ] Approval expiration (configurable TTL, default 4 hours)
- [ ] Tech can modify parameters before approving (e.g., change schedule, reduce device scope)
- [ ] Dashboard widget: pending approvals queue

**Why third**: High-risk actions need approval before execution. Without this, the brain is limited to low-risk read-only operations.

#### 1.4 Brain Authentication & Registration
- [ ] `POST /api/v1/brain/register` — register a brain (BYOK or LanternOps)
  - Returns: session token, tool catalog, risk policy, RMM capabilities
- [ ] `X-Brain-Type` header: `byok` | `lanternops` | `custom`
- [ ] Brain session management (creation, revocation, scoping to tenants)
- [ ] Mutual TLS support for LanternOps connections
- [ ] API key scoping: brain-specific API keys with tool-level permissions

#### 1.5 Event Emission System
- [ ] Structured event envelope (event_id, type, timestamp, tenant_id, device_id, severity, details)
- [ ] Event types mapped from existing alert/monitor systems:
  - `security_event`, `patch_failed`, `performance_threshold`, `login_failure`
  - `software_installed`, `policy_violation`, `service_stopped`, `network_change`
- [ ] `WebSocket /api/v1/brain/events` — real-time event stream (brain subscribes)
- [ ] Event filtering (by tenant, severity, category)
- [ ] Event correlation IDs (link related events)
- [ ] Backpressure handling for high-volume environments

---

### Phase 2: BYOK Agent Loop (Open Source AI)
**Priority: HIGH — This is the free tier that drives adoption and upsell**

BYOK ships with the open-source RMM. MSPs bring their own Anthropic API key. It's intentionally limited but genuinely useful.

#### 2.1 BYOK Configuration UI
- [ ] Settings page: Settings → AI Brain → BYOK
- [ ] API key input (encrypted storage, never logged)
- [ ] Model selection (Sonnet default, Haiku for cost-conscious)
- [ ] Token budget limits (daily/monthly caps per org)
- [ ] Enable/disable toggle
- [ ] Test connection button

#### 2.2 BYOK Agent Loop
- [ ] `apps/api/src/brain/byok/agent.ts` — single-agent reactive loop
- [ ] Receives events from the event system (Phase 1.5)
- [ ] Constructs messages with event context
- [ ] Calls Claude API with tool definitions from catalog
- [ ] Executes tool calls through the brain connector (with risk enforcement)
- [ ] Standard tool-use loop (call → result → call → ... → final response)
- [ ] Response surfaced to dashboard as "AI Analysis" card

#### 2.3 BYOK Limitations (by design)
- No persistent memory between events
- No cross-tenant pattern matching
- No playbook library
- No background/proactive analysis
- No escalation routing beyond basic approval
- Single-event reactive only (no multi-event correlation)
- Basic system prompt (no tenant-specific tuning)

These limitations are the upgrade path to LanternOps.

#### 2.4 BYOK Dashboard Integration
- [ ] "AI Insights" panel on device detail page
- [ ] "AI Triage" column in alerts list (auto-populated if BYOK enabled)
- [ ] Action log showing AI-initiated actions with reasoning
- [ ] Cost tracking dashboard (tokens used, estimated spend)

---

### Phase 3: LanternOps Connection Interface (RMM Side)
**Priority: HIGH — Enables the commercial product without modifying the open-source core**

This is what the RMM needs to support LanternOps connecting remotely. The RMM remains sovereign — LanternOps requests, the RMM decides.

#### 3.1 LanternOps Registration Flow
- [ ] Settings → AI Brain → LanternOps → "Connect" button
- [ ] OAuth flow: redirect to LanternOps signup/login
- [ ] Callback: LanternOps sends credentials, RMM calls `/brain/register`
- [ ] Connection status indicator (active, disconnected, error)
- [ ] Tenant selection: which orgs to share with LanternOps
- [ ] Disconnect button with confirmation

#### 3.2 Secure Tunnel / Webhook Endpoint
- [ ] HTTPS endpoint for LanternOps → RMM tool calls
- [ ] Mutual TLS verification (LanternOps certificate pinning)
- [ ] Request signing (HMAC or JWT) for tamper detection
- [ ] Rate limiting per LanternOps connection
- [ ] IP allowlisting (optional, for enterprise)
- [ ] Fallback: webhook-based if WebSocket unavailable

#### 3.3 Event Stream to LanternOps
- [ ] Persistent WebSocket from RMM → LanternOps cloud
- [ ] Reconnection with exponential backoff
- [ ] Event buffering during disconnection (configurable retention)
- [ ] Heartbeat/keepalive
- [ ] Tenant-scoped filtering (only events for authorized tenants)

#### 3.4 Audit & Transparency
- [ ] All LanternOps actions logged with `actor: "lanternops"` in audit trail
- [ ] Dashboard view: "Actions taken by LanternOps" with full reasoning
- [ ] MSP admin can review and revoke LanternOps access at any time
- [ ] Data residency controls (what data leaves the RMM vs stays local)

---

### Phase 4: LanternOps Cloud Platform (Commercial Side)
**Priority: MEDIUM — This is the paid product, built separately from the OSS RMM**

This is the LanternOps cloud service. Deployed on DigitalOcean (cloud-agnostic design). Connects to one or more RMM instances and provides the intelligent brain. Uses Claude Agent SDK (Python) for multi-agent orchestration.

#### 4.1 RMM Client Library
- [ ] `RMMClient` class: authenticated HTTP client to customer's RMM
- [ ] Connection pool management (multiple customers)
- [ ] Retry logic with circuit breaker
- [ ] Response caching for read-heavy tools
- [ ] Health monitoring per RMM connection
- [ ] DigitalOcean deployment: App Platform or Droplets behind DO Load Balancer

#### 4.2 Tool Wrapper Layer
- [ ] Tool functions that wrap RMM API calls
- [ ] LanternOps enrichment layer (add memory context to responses)
- [ ] Pre-validation layer (LanternOps's own safety checks before sending to RMM)
  - Timing analysis ("heavy usage hours, recommend scheduling later")
  - Historical failure detection ("similar script caused BSOD last week")
  - Cross-tenant risk signals ("3 tenants reported issues with this patch")

#### 4.3 Triage Agent (Claude Agent SDK — Python)
- [ ] First responder agent using `AgentDefinition` with model `sonnet` (cost/speed balance)
- [ ] System prompt with MSP context + operational guidelines
- [ ] Tools: all RMM tools + `query_memory`, `check_cross_tenant`, `invoke_playbook`
- [ ] Decision tree: known pattern → playbook, novel → investigate
- [ ] Escalation logic: route to right tech based on expertise + availability
- [ ] Subagent pattern: triage spawns remediation/compliance as subagents

#### 4.4 Remediation Agent
- [ ] Specialist agent: validates diagnosis, executes fix, verifies result
- [ ] Tools: RMM tools + `update_memory`, `log_resolution`, `verify_remediation`
- [ ] Post-fix verification loop (check that the fix actually worked)
- [ ] Rollback capability (if fix made things worse)

#### 4.5 Compliance Agent
- [ ] Continuous compliance monitoring
- [ ] Framework support: NIST 800-171, CIS v8, SOC 2, HIPAA
- [ ] Evidence artifact generation (config dumps, screenshots, log exports)
- [ ] Compliance drift detection + alerting
- [ ] Client-ready report generation

---

### Phase 5: Intelligence Layer (LanternOps Differentiator)
**Priority: MEDIUM — This is what makes LanternOps worth paying for**

#### 5.1 Tenant Memory Store
- [ ] Persistent per-tenant memory (past incidents, resolutions, device quirks)
- [ ] Vector store for semantic search across memory
- [ ] Device profiles (known issues, hardware quirks, client preferences)
- [ ] Automatic memory extraction from resolved incidents
- [ ] Memory decay (old, irrelevant memories lose priority)

#### 5.2 Cross-Tenant Intelligence
- [ ] Anonymized pattern matching across all managed tenants
- [ ] "This error seen on X devices across Y tenants, known fix has Z% success rate"
- [ ] Patch risk scoring (based on cross-tenant failure rates)
- [ ] Emerging threat detection (pattern appears across multiple tenants)
- [ ] Privacy-preserving aggregation (no tenant-identifiable data shared)

#### 5.3 Playbook Engine
- [ ] Pre-built operational playbooks (encoded best practices)
- [ ] Playbook builder (create from successful past resolutions)
- [ ] Playbook versioning and approval
- [ ] Conditional execution (if/then branching based on results)
- [ ] Playbook marketplace (share across LanternOps customers)

#### 5.4 Proactive Analysis
- [ ] Background scanning for potential issues
- [ ] "Devices likely to hit disk space issues in 2 weeks"
- [ ] "Patch X has high failure rate, hold deployment"
- [ ] "Device Y hasn't reported in, but historically goes offline at this time"
- [ ] Anomaly detection on metrics (not just threshold alerts)

---

### Phase 6: Operational Excellence (Polish & Scale)
**Priority: LOWER — Important but not blocking launch**

#### 6.1 Token Optimization
- [ ] Context window management (summarize vs full context)
- [ ] Tool result caching (don't re-fetch unchanged data)
- [ ] Batch similar events (don't triage each disk warning individually)
- [ ] Model routing (Haiku for classification, Sonnet for remediation)

#### 6.2 Tech-Facing Features
- [ ] Escalation routing to the right tech (based on expertise tags)
- [ ] Tech performance analytics ("mean time to resolve by category")
- [ ] Shift-aware routing (don't escalate to off-duty techs)
- [ ] In-app chat between AI and tech (not just approval/deny)

#### 6.3 Client-Facing Features
- [ ] Branded client portal with AI-generated status updates
- [ ] Automated incident summaries for client communication
- [ ] SLA monitoring + proactive notification
- [ ] Self-service requests through portal (AI pre-validates)

#### 6.4 Multi-RMM Support
- [ ] Single LanternOps account managing multiple RMM instances
- [ ] Unified view across RMMs
- [ ] Cross-RMM correlation (same client, different sites, different RMMs)

---

## Implementation Order & Dependencies

```
Phase 1 (Foundation)     Phase 2 (BYOK)        Phase 3 (LanternOps RMM)
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ 1.1 Tool Catalog │───►│ 2.1 BYOK Config  │    │ 3.1 OAuth Flow   │
│ 1.2 Risk Engine  │───►│ 2.2 Agent Loop   │    │ 3.2 Secure Tunnel│
│ 1.3 Approvals    │───►│ 2.3 (Limitations)│    │ 3.3 Event Stream │
│ 1.4 Brain Auth   │───►│ 2.4 Dashboard    │    │ 3.4 Audit/Transp │
│ 1.5 Event System │────┤                  │    │                  │
└──────────────────┘    └──────────────────┘    └──────────────────┘
         │                       │                       │
         │                       │                       │
         ▼                       ▼                       ▼
Phase 4 (LanternOps Cloud) ◄────────────────────────────┘
┌──────────────────┐
│ 4.1 RMM Client   │
│ 4.2 Tool Wrappers│
│ 4.3 Triage Agent │
│ 4.4 Remediation  │
│ 4.5 Compliance   │
└──────────────────┘
         │
         ▼
Phase 5 (Intelligence)
┌──────────────────┐
│ 5.1 Tenant Memory│
│ 5.2 Cross-Tenant │
│ 5.3 Playbooks    │
│ 5.4 Proactive    │
└──────────────────┘
         │
         ▼
Phase 6 (Polish & Scale)
┌──────────────────┐
│ 6.1 Token Optim  │
│ 6.2 Tech Features│
│ 6.3 Client Portal│
│ 6.4 Multi-RMM    │
└──────────────────┘
```

**Key dependencies**:
- Phase 1 blocks everything — it's the API contract
- Phases 2 and 3 can be built in parallel (both consume Phase 1)
- Phase 4 requires Phase 3 (needs the RMM-side connection infra)
- Phase 5 requires Phase 4 (needs the agent orchestration layer)
- Phase 6 is independent and can start anytime after Phase 4

---

## What Ships Where

| Component | Ships With | License |
|-----------|-----------|---------|
| Tool catalog + schemas | Open Source RMM | OSS |
| Risk classification engine | Open Source RMM | OSS |
| Approval workflow | Open Source RMM | OSS |
| Brain connector API | Open Source RMM | OSS |
| Event emission system | Open Source RMM | OSS |
| BYOK agent loop | Open Source RMM | OSS |
| LanternOps connection UI | Open Source RMM | OSS |
| RMM client library | LanternOps Cloud | Commercial |
| Multi-agent orchestration | LanternOps Cloud | Commercial |
| Tenant memory store | LanternOps Cloud | Commercial |
| Cross-tenant intelligence | LanternOps Cloud | Commercial |
| Playbook engine | LanternOps Cloud | Commercial |
| Compliance agents | LanternOps Cloud | Commercial |

---

## Estimated Effort

| Phase | Scope | Complexity | Notes |
|-------|-------|-----------|-------|
| **Phase 1** | 6 sub-phases (incl. AI retrofit) | High | Core architecture, get it right the first time |
| **Phase 2** | 4 sub-phases | Medium | Standard agent loop, existing patterns |
| **Phase 3** | 4 sub-phases | Medium-High | Security-critical connection infra |
| **Phase 4** | 5 sub-phases | High | New codebase (LanternOps cloud), Agent SDK integration |
| **Phase 5** | 4 sub-phases | Very High | ML/vector stores, privacy-preserving aggregation |
| **Phase 6** | 4 sub-phases | Medium | Optimization and UX polish |

---

## Infrastructure Notes

### DigitalOcean Deployment (Phase 4+)
- **LanternOps cloud**: DigitalOcean App Platform or Droplets (cloud-agnostic design, portable to AWS/GCP later)
- **RMM + LanternOps co-located**: Both in same DO region reduces latency for tool calls
- **Data residency**: Simplified by co-location. Future multi-region via DO regions.
- **Managed services**: DO Managed PostgreSQL, DO Managed Redis, DO Spaces (S3-compatible) for artifacts

### Claude Agent SDK Notes
- **Models**: `sonnet | opus | haiku` — Anthropic-native only
- **Subagents**: Can spawn specialized agents (triage, remediation, compliance) but subagents cannot spawn their own subagents
- **Tool schemas**: Standard JSON Schema — the same format used by other providers, enabling future portability without rewriting tool definitions
- **Python + TypeScript**: SDK available in both. LanternOps cloud likely Python (richer Agent SDK features). RMM BYOK loop in TypeScript (matches existing codebase).
- **Third-party APIs**: Agent tools can call any HTTP API — this is how LanternOps tools call the RMM remotely

### Cost Tracking
- **Per-device pricing** initially: `aiCostUsage` tracks tokens per device, monthly aggregation per org
- **Per-action tracking** added later: `aiToolExecutions` already logs each tool call — extend with cost attribution
- **Budget enforcement**: `aiBudgets` already supports per-org limits — extend with per-device quotas

## Remaining Open Questions

1. **BYOK TypeScript vs Python**: BYOK agent loop should be TypeScript to match the RMM codebase. The Anthropic TS SDK supports tool use natively. But the Agent SDK (with subagents) is more mature in Python. BYOK doesn't need subagents, so TS is fine.
2. **Event batching strategy**: How to handle 100+ events/minute during incidents without spinning up 100 agent sessions? Likely needs an event aggregator/deduplicator in Phase 1.5.
3. **LanternOps separate repo**: Phase 4+ is a separate codebase/repo? Or monorepo with the RMM? Affects CI/CD and deployment.
