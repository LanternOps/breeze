---
name: ai-agent
description: Quick reference for the Breeze RMM AI Agent system architecture, MCP tools, streaming chat, cost tracking, guardrails, and MCP server. Use when working on AI features, debugging chat issues, adding new tools, or understanding the AI data flow.
---

# Breeze RMM AI Agent System Reference

Integrated AI agent allowing IT technicians to manage devices, troubleshoot issues, analyze security, and build automations through natural language chat.

## Architecture Overview

```
 External Clients (Claude Desktop, Cursor)
          |  MCP over SSE/HTTP
          v
 +---------------------------+
 | Breeze MCP Server         |  /api/v1/mcp/*  (API Key auth)
 +---------------------------+
          |
 +------------------------------------------------------------------+
 |                     Hono API Server                               |
 |                                                                   |
 |  AI Chat Routes           MCP Server Routes                      |
 |  /api/v1/ai/*             /api/v1/mcp/*                          |
 |       |                        |                                  |
 |  +--------------------------------------------------+            |
 |  |         AI Agent Service (aiAgent.ts)             |            |
 |  |  Anthropic SDK + In-Process Tool Execution        |            |
 |  |                                                   |            |
 |  |  12 Custom Tools (aiTools.ts):                    |            |
 |  |   query_devices, get_device_details,              |            |
 |  |   execute_command, run_script, manage_alerts,     |            |
 |  |   security_scan, analyze_metrics,                 |            |
 |  |   manage_services, file_operations,               |            |
 |  |   create_automation, query_audit_log,             |            |
 |  |   network_discovery                               |            |
 |  +--------------------------------------------------+            |
 |       |                    |                    |                  |
 |  Existing Services    commandQueue.ts     Event Bus (Redis)       |
 +------------------------------------------------------------------+
          |                        |
    PostgreSQL              Go Agent (on devices)
```

## File Map

### Backend (API)

| File | Purpose |
|------|---------|
| `apps/api/src/db/schema/ai.ts` | 5 tables: `aiSessions`, `aiMessages`, `aiToolExecutions`, `aiCostUsage`, `aiBudgets` |
| `apps/api/src/services/aiAgent.ts` | Core agent service — session lifecycle, Anthropic API calls, SSE streaming, tool dispatch, approval polling |
| `apps/api/src/services/aiTools.ts` | 12 MCP tool implementations with Zod schemas, org-scoped access via `AuthContext.orgCondition()` |
| `apps/api/src/services/aiGuardrails.ts` | 4-tier permission system: auto-execute, audit, approval-required, blocked |
| `apps/api/src/services/aiCostTracker.ts` | Token/cost tracking, budget enforcement, rate limiting, usage summaries |
| `apps/api/src/routes/ai.ts` | REST + SSE chat endpoints (`/api/v1/ai/*`) |
| `apps/api/src/routes/mcpServer.ts` | External MCP server for Claude Desktop/Cursor (`/api/v1/mcp/*`) |

### Frontend (Web)

| File | Purpose |
|------|---------|
| `apps/web/src/stores/aiStore.ts` | Zustand store — sessions, messages, streaming, context, approval state |
| `apps/web/src/components/ai/AiChatSidebar.tsx` | Slide-out panel (right side), session management, conversation history |
| `apps/web/src/components/ai/AiChatMessages.tsx` | Scrollable message list with markdown rendering |
| `apps/web/src/components/ai/AiChatInput.tsx` | Auto-resize textarea, Cmd+Enter send |
| `apps/web/src/components/ai/AiToolCallCard.tsx` | Collapsible tool invocation display with input/output |
| `apps/web/src/components/ai/AiApprovalDialog.tsx` | Approve/Reject card for Tier 3 tool executions |
| `apps/web/src/components/ai/AiContextBadge.tsx` | Shows current page context injected into chat |
| `apps/web/src/components/ai/AiCostIndicator.tsx` | Token usage + budget remaining (with polling circuit breaker) |
| `apps/web/src/components/settings/AiUsagePage.tsx` | Admin dashboard for AI usage and budget configuration |
| `apps/web/src/pages/settings/ai-usage.astro` | Astro page wrapper for AI usage admin |

### Shared

| File | Purpose |
|------|---------|
| `packages/shared/src/types/ai.ts` | TypeScript interfaces: `AiSession`, `AiMessage`, `AiToolExecution`, `AiPageContext`, `AiStreamEvent` |
| `packages/shared/src/validators/ai.ts` | Zod schemas for AI page context and message validation |

## Database Schema

5 tables in `apps/api/src/db/schema/ai.ts`:

| Table | Key Columns | Purpose |
|-------|-------------|---------|
| `ai_sessions` | orgId, userId, status, model, turnCount, totalCostCents | Multi-turn conversations |
| `ai_messages` | sessionId, role, content, toolName, toolInput, toolOutput | Message history |
| `ai_tool_executions` | sessionId, toolName, status, approvedBy, commandId | Tool audit trail |
| `ai_cost_usage` | orgId, period, periodKey, inputTokens, outputTokens, totalCostCents | Daily/monthly cost aggregates |
| `ai_budgets` | orgId, enabled, monthlyBudgetCents, dailyBudgetCents, maxTurnsPerSession | Per-org budget config |

Enums: `ai_session_status` (active/closed/expired), `ai_message_role` (user/assistant/system/tool_use/tool_result), `ai_tool_status` (pending/approved/executing/completed/failed/rejected)

## API Routes

### Chat Routes (`/api/v1/ai/*`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/sessions` | Create session (with optional page context) |
| GET | `/sessions` | List user's sessions (filterable by status) |
| GET | `/sessions/search` | Search past conversations (must be before `:id` route!) |
| GET | `/sessions/:id` | Get session with message history |
| DELETE | `/sessions/:id` | Close session |
| POST | `/sessions/:id/messages` | Send message, returns SSE stream |
| POST | `/sessions/:id/approve/:executionId` | Approve/reject tool execution |
| GET | `/usage` | Usage + budget summary for org |
| PUT | `/budget` | Update budget settings |
| GET | `/admin/sessions` | Session history for admin dashboard |

### MCP Server Routes (`/api/v1/mcp/*`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/sse` | API Key (`ai:*`) | SSE transport (server→client) |
| POST | `/message` | API Key (`ai:*`) | JSON-RPC messages (client→server) |

Session ownership validated — each SSE session tracks `apiKeyId`. Max 100 sessions, 30-min TTL.

## SSE Stream Events

Events emitted by `POST /sessions/:id/messages`:

```typescript
type AiStreamEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'content_delta'; delta: string }
  | { type: 'tool_use_start'; toolName: string; toolUseId: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; output: unknown; isError: boolean }
  | { type: 'approval_required'; executionId: string; toolName: string; input: Record<string, unknown>; description: string }
  | { type: 'message_end'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
  | { type: 'done' };
```

## 12 MCP Tools

| Tool | Tier | Description |
|------|------|-------------|
| `query_devices` | 1 | Filter devices by status, OS, site, tags, hostname |
| `get_device_details` | 1 | Full device profile (hardware, network, metrics) |
| `analyze_metrics` | 1 | Time-series CPU/RAM/disk/network with aggregation |
| `manage_alerts` | 1-2 | List/get (T1), acknowledge/resolve (T2) |
| `query_audit_log` | 1 | Search audit logs with org scoping |
| `execute_command` | 3 | Run device commands (requires approval) |
| `run_script` | 3 | Execute scripts on devices (requires approval) |
| `manage_services` | 1-3 | List (T1), start/stop/restart (T3) |
| `security_scan` | 1-3 | Status check (T1), quarantine/remove (T3) |
| `file_operations` | 1-3 | List/read (T1), write/delete (T3) |
| `create_automation` | 3 | Create automation rules (requires approval) |
| `network_discovery` | 3 | Subnet scanning (requires approval) |

### Helper Functions in aiTools.ts

| Helper | Purpose |
|--------|---------|
| `verifyDeviceAccess(deviceId, auth, requireOnline?)` | Device lookup + org condition check |
| `findAlertWithAccess(alertId, auth)` | Alert lookup + org condition check |
| `getCommandQueue()` | Cached dynamic import of commandQueue module |
| `getToolTier(toolName)` | Returns numeric tier for guardrails |
| `executeTool(toolName, input, auth)` | Main dispatch — throws for unknown tools |

## Guardrails (4-Tier System)

Defined in `aiGuardrails.ts`:

| Tier | Behavior | Examples |
|------|----------|---------|
| **1** | Auto-execute | query_devices, get_device_details, analyze_metrics, query_audit_log |
| **2** | Auto-execute + audit log | manage_alerts(acknowledge/resolve), manage_services(list) |
| **3** | Requires user approval (5-min timeout) | execute_command, run_script, file writes, service start/stop |
| **4** | Blocked | Unknown tools, auth modifications |

Action-based escalation: `TIER3_ACTIONS` maps tool+action combos that escalate (e.g., `file_operations.write` escalates from T1 to T3).

## Approval Flow

1. AI invokes a Tier 3 tool
2. `aiAgent.ts` inserts `aiToolExecutions` record with status `'pending'`
3. SSE emits `approval_required` event with tool name, input, description
4. Frontend shows `AiApprovalDialog` inline in chat
5. User clicks Approve/Reject -> `POST /sessions/:id/approve/:executionId`
6. `waitForApproval()` polls DB every 2s with circuit breaker (max 5 consecutive DB errors)
7. 5-minute auto-reject timeout
8. On approval: existing record updated to `'executing'`, tool runs, result returned

## Cost Tracking

In `aiCostTracker.ts`:

| Function | Purpose |
|----------|---------|
| `calculateCostCents(model, inputTokens, outputTokens)` | Claude pricing math |
| `checkBudget(orgId)` | Pre-message budget check (fails closed on DB errors) |
| `checkAiRateLimit(userId, orgId)` | 20 msg/min per user, 200 msg/hr per org |
| `recordUsage(sessionId, orgId, model, inputTokens, outputTokens, isToolExecution)` | Atomic transaction: session update + daily/monthly aggregate upserts |
| `updateBudget(orgId, settings)` | Upsert budget configuration |
| `getUsageSummary(orgId)` | Daily + monthly usage + budget for admin dashboard |
| `getSessionHistory(orgId, { limit, offset })` | Session list for admin |

Model pricing (cents per million tokens):
- `claude-sonnet-4-5-20250929`: 300 input / 1500 output
- `claude-haiku-4-5-20251001`: 100 input / 500 output

## Page Context Injection

Frontend pushes context to `aiStore.setPageContext()`:

```typescript
type AiPageContext =
  | { type: 'device'; id: string; hostname: string; os?: string; status?: string; ip?: string }
  | { type: 'alert'; id: string; title: string; severity?: string; deviceHostname?: string }
  | { type: 'dashboard'; orgName?: string; deviceCount?: number; alertCount?: number }
  | { type: 'custom'; label: string; data: Record<string, unknown> };
```

Context is injected into the system prompt and sent with each message. The `AiContextBadge` component shows it visually in the chat header.

## Data Flow: Chat Message

```
1. User types message in AiChatInput
2. aiStore.sendMessage(content)
   - Creates session if needed (POST /sessions)
   - Adds user message optimistically
   - POST /sessions/:id/messages with SSE stream
3. API receives message
   - checkAiRateLimit() — fail closed on Redis error
   - checkBudget() — fail closed on DB error
   - Insert user message to ai_messages
   - Build Anthropic messages array from conversation history
   - Call Anthropic API with tools + system prompt
4. Stream processing (generator function)
   - Yield message_start, content_delta events
   - On tool_use: check guardrails
     - Tier 1-2: execute immediately
     - Tier 3: insert execution record, yield approval_required, wait
     - Tier 4: return error
   - Yield tool_result events
   - On message_end: recordUsage() in transaction
   - Yield done
5. Frontend processes SSE events via processStreamEvent()
   - Updates Zustand store incrementally
   - Shows tool cards, approval dialogs, streaming text
```

## Key Patterns & Safety

- **Fail-closed**: Rate limit and budget checks deny requests when Redis/DB is down
- **Circuit breaker**: `waitForApproval` breaks after 5 consecutive DB poll failures
- **ILIKE escaping**: `escapeLike()` helper prevents SQL wildcard injection in search
- **Transaction wrapping**: `recordUsage` uses `db.transaction()` for atomicity
- **Session ownership**: MCP SSE sessions track `apiKeyId` to prevent cross-session injection
- **Polling circuit breaker**: `AiCostIndicator` stops after 5 failures or auth errors
- **Route ordering**: `/sessions/search` registered before `/sessions/:id` in Hono
- **No dual records**: Approval flow updates existing execution record instead of creating a second one

## Connecting External Clients

```bash
# Claude Desktop / Cursor MCP connection
claude mcp add breeze-rmm \
  --transport sse \
  --url https://your-api/api/v1/mcp/sse \
  --header "X-API-Key: brz_..."
```

API key needs `ai:read`, `ai:write`, or `ai:execute` scopes.
