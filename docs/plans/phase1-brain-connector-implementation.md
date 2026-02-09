# Phase 1: Brain Connector Foundation — Implementation Document

## Overview

Phase 1 transforms Breeze's existing AI integration into the **brain connector** — the API contract that both BYOK and LanternOps consume. The existing code is well-structured and production-ready; this is a **retrofit and extension**, not a rewrite.

### What Exists (Reuse)
| Component | File | Status |
|-----------|------|--------|
| Tool registry (`Map<string, AiTool>`) | `services/aiTools.ts` | Reuse as-is, extend |
| 4-tier guardrails (read/mutate/approve/block) | `services/aiGuardrails.ts` | Evolve into risk engine |
| Approval workflow (`ai_tool_executions`) | `services/aiAgent.ts` | Extend with notifications |
| Cost tracking + budgets | `services/aiCostTracker.ts` | Adapt for per-device pricing |
| SSE streaming | `routes/ai.ts` | Reuse for brain events |
| MCP tool protocol | `routes/mcpServer.ts` | Reuse JSON-RPC patterns |
| API key auth + scopes | `middleware/apiKeyAuth.ts` | Clone for brain keys |
| WebSocket infra | `routes/agentWs.ts` | Extend for brain events |
| Multi-tenant isolation | `auth.orgCondition()` | Reuse everywhere |

### What's New (Build)
| Component | Purpose |
|-----------|---------|
| Brain module (`apps/api/src/brain/`) | Central home for all brain logic |
| Risk policy engine | Configurable, context-aware risk classification |
| Event emission system | Structured events from alerts/monitors → brain |
| Brain registration API | Register BYOK/LanternOps connections |
| Tool catalog versioning | Semver'd tool schemas as the API contract |

---

## 1.0 Retrofit Existing AI Code

**Goal**: Move AI code into `brain/` module. Everything continues to work — same endpoints, same UI, same behavior. Just reorganized.

### Directory Structure

```
apps/api/src/brain/
├── index.ts                    # Re-exports, brain module entry
├── routes.ts                   # All brain HTTP routes (retrofit from ai.ts)
├── engine.ts                   # Core agent loop (retrofit from aiAgent.ts)
├── tools/
│   ├── registry.ts             # Tool registry Map + registration (from aiTools.ts)
│   ├── device-tools.ts         # query_devices, get_device_details
│   ├── alert-tools.ts          # manage_alerts
│   ├── script-tools.ts         # run_script, execute_command
│   ├── file-tools.ts           # file_operations
│   ├── service-tools.ts        # manage_services
│   ├── patch-tools.ts          # get_patch_status, deploy_patches (NEW)
│   ├── report-tools.ts         # generate_report (NEW)
│   └── discovery-tools.ts      # network_discovery (NEW)
├── risk/
│   ├── classifier.ts           # Risk classification engine (evolve from aiGuardrails.ts)
│   ├── policies.ts             # Default + custom risk policies
│   └── context.ts              # Context-aware risk (maintenance windows, bulk thresholds)
├── approvals/
│   ├── manager.ts              # Approval creation, polling, notification dispatch
│   └── routes.ts               # Approval HTTP endpoints
├── events/
│   ├── emitter.ts              # Event emission from alerts/monitors
│   ├── envelope.ts             # Structured event types
│   ├── stream.ts               # WebSocket event stream for brain subscribers
│   └── aggregator.ts           # Event batching/dedup for high-volume
├── auth/
│   ├── brainAuth.ts            # Brain-specific auth middleware
│   ├── registration.ts         # Brain registration endpoint
│   └── sessions.ts             # Brain session management
├── cost/
│   ├── tracker.ts              # Cost tracking (from aiCostTracker.ts)
│   └── budget.ts               # Budget enforcement
└── types.ts                    # All brain TypeScript types
```

### Step-by-Step

#### 1.0.1 Create `brain/` directory and move files

| Old Location | New Location | Changes |
|-------------|-------------|---------|
| `services/aiAgent.ts` | `brain/engine.ts` | Rename exports: `sendMessage` → `brainSendMessage` (alias old name for compat) |
| `services/aiTools.ts` | `brain/tools/registry.ts` | Split tool definitions into per-group files |
| `services/aiGuardrails.ts` | `brain/risk/classifier.ts` | Rename "tier" → "risk level" in types |
| `services/aiCostTracker.ts` | `brain/cost/tracker.ts` | No changes needed |
| `routes/ai.ts` | `brain/routes.ts` | Update imports, keep same URL paths |

#### 1.0.2 Update route mounting

```typescript
// apps/api/src/routes/index.ts
// Old:
import { aiRoutes } from './ai';
app.route('/ai', aiRoutes);

// New:
import { brainRoutes } from '../brain/routes';
app.route('/ai', brainRoutes);          // Keep old paths for backward compat
app.route('/brain', brainRoutes);       // New canonical path (both work)
```

#### 1.0.3 Split tool definitions into per-group files

Each tool file exports a `register()` function called from `registry.ts`:

```typescript
// brain/tools/device-tools.ts
import { registerTool } from './registry';
import type { BrainTool } from '../types';

export function registerDeviceTools(): void {
  registerTool({
    definition: {
      name: 'list_devices',
      description: 'List managed devices with optional filters...',
      input_schema: { /* ... */ }
    },
    riskLevel: 'low',
    handler: async (input, auth) => { /* existing logic from aiTools.ts */ }
  });

  registerTool({
    definition: {
      name: 'get_device_details',
      description: 'Get comprehensive device details...',
      input_schema: { /* ... */ }
    },
    riskLevel: 'low',
    handler: async (input, auth) => { /* existing logic */ }
  });
}
```

```typescript
// brain/tools/registry.ts
import { registerDeviceTools } from './device-tools';
import { registerAlertTools } from './alert-tools';
import { registerScriptTools } from './script-tools';
// ... etc

const brainTools = new Map<string, BrainTool>();

export function registerTool(tool: BrainTool): void {
  brainTools.set(tool.definition.name, tool);
}

export function getToolCatalog(): ToolCatalogEntry[] {
  return Array.from(brainTools.values()).map(t => ({
    name: t.definition.name,
    description: t.definition.description,
    input_schema: t.definition.input_schema,
    riskLevel: t.riskLevel,
    version: t.version ?? '1.0.0',
  }));
}

// Initialize all tools
export function initializeTools(): void {
  registerDeviceTools();
  registerAlertTools();
  registerScriptTools();
  registerFileTools();
  registerServiceTools();
  registerPatchTools();
  registerReportTools();
  registerDiscoveryTools();
}
```

#### 1.0.4 Update shared types

```typescript
// packages/shared/src/types/brain.ts (new file, re-exports ai.ts types with new names)

// Risk levels replace tiers
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

// Brain types (superset of AI types)
export type BrainType = 'byok' | 'lanternops';
export type BrainSessionStatus = 'active' | 'closed' | 'expired';
export type BrainApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'modified';

// Re-export existing types with aliases for backward compat
export type { AiStreamEvent as BrainStreamEvent } from './ai';
export type { AiPageContext as BrainContext } from './ai';
```

#### 1.0.5 Update frontend imports

```typescript
// apps/web/src/components/ai/AiChatSidebar.tsx
// Update API calls from /api/ai/* to /api/brain/* (keep /api/ai/* as alias during transition)
// No UI changes in this step
```

#### 1.0.6 Verification

- [ ] All existing AI chat functionality works identically
- [ ] `/api/ai/*` routes still respond (backward compat aliases)
- [ ] `/api/brain/*` routes respond identically
- [ ] MCP server still works
- [ ] Cost tracking still works
- [ ] Approval flow still works
- [ ] All existing tests pass

---

## 1.1 Tool Catalog Registry

**Goal**: Formalize the tool registry as a versioned, queryable API contract. Add new tools for RMM capabilities not yet exposed to AI.

### 1.1.1 Catalog endpoint

```typescript
// brain/routes.ts — new endpoint

// GET /brain/catalog
// Returns all available tools with their schemas, risk levels, and versions.
// This IS the API contract between the RMM and any brain (BYOK or LanternOps).

brainRoutes.get('/catalog', authMiddleware, async (c) => {
  const auth = c.get('auth');
  const catalog = getToolCatalog();

  // Filter by what this caller can see
  // (brain keys may have scoped tool access)
  const filtered = filterToolsByAuth(catalog, auth);

  return c.json({
    version: '1.0.0',                    // Catalog version (semver)
    tools: filtered,
    riskPolicy: getRiskPolicy(auth.orgId), // Current risk classifications
    capabilities: getRmmCapabilities(),    // What this RMM instance supports
  });
});
```

### 1.1.2 New tools to register

These RMM capabilities exist but aren't yet exposed as brain tools:

| Tool | Risk Level | Source | Notes |
|------|-----------|--------|-------|
| `get_patch_status` | low | `routes/patches.ts` | Read patch compliance per device/org |
| `deploy_patches` | high | `routes/patches.ts` | Deploy patches, requires approval |
| `get_monitors` | low | `routes/monitors.ts` | List network monitors and results |
| `run_discovery` | medium | `routes/discovery.ts` | Trigger network scan |
| `get_discovery_results` | low | `routes/discovery.ts` | Read discovered assets |
| `generate_report` | low | `routes/reports.ts` | Generate compliance/inventory report |
| `get_automations` | low | `routes/automations.ts` | List automation rules |
| `get_backup_status` | low | `routes/backup.ts` | Check backup job status |

Implementation pattern — same as existing tools:

```typescript
// brain/tools/patch-tools.ts
export function registerPatchTools(): void {
  registerTool({
    definition: {
      name: 'get_patch_status',
      description: 'Get patch compliance status across devices. Shows missing, pending, installed, and failed patches by severity.',
      input_schema: {
        type: 'object',
        properties: {
          tenant_id: { type: 'string', description: 'Organization ID' },
          device_id: { type: 'string', description: 'Optional: specific device' },
          severity_filter: { enum: ['critical', 'important', 'moderate', 'low'] },
          status_filter: { enum: ['missing', 'pending', 'installed', 'failed'] },
        },
        required: ['tenant_id'],
      },
    },
    riskLevel: 'low',
    version: '1.0.0',
    handler: async (input, auth) => {
      if (!auth.canAccessOrg(input.tenant_id)) {
        return JSON.stringify({ error: 'Access denied' });
      }
      // Query devicePatches + patches tables
      const results = await db.select()
        .from(devicePatches)
        .innerJoin(patches, eq(devicePatches.patchId, patches.id))
        .where(and(
          auth.orgCondition(devicePatches.orgId),
          input.device_id ? eq(devicePatches.deviceId, input.device_id) : undefined,
          input.severity_filter ? eq(patches.severity, input.severity_filter) : undefined,
          input.status_filter ? eq(devicePatches.status, input.status_filter) : undefined,
        ))
        .limit(100);

      return JSON.stringify({
        total: results.length,
        patches: results.map(r => ({
          patchId: r.patches.id,
          title: r.patches.title,
          severity: r.patches.severity,
          deviceId: r.device_patches.deviceId,
          status: r.device_patches.status,
          installedAt: r.device_patches.installedAt,
        })),
      });
    },
  });

  registerTool({
    definition: {
      name: 'deploy_patches',
      description: 'Deploy patches to devices. Supports immediate or scheduled deployment. Requires approval for off-window deployments.',
      input_schema: {
        type: 'object',
        properties: {
          device_ids: { type: 'array', items: { type: 'string' } },
          patch_ids: { type: 'array', items: { type: 'string' } },
          schedule: {
            type: 'object',
            properties: {
              type: { enum: ['immediate', 'maintenance_window', 'scheduled'] },
              datetime: { type: 'string', format: 'date-time' },
              reboot_policy: { enum: ['auto', 'defer', 'force', 'user_prompt'] },
            },
          },
          reason: { type: 'string' },
        },
        required: ['device_ids', 'patch_ids', 'reason'],
      },
    },
    riskLevel: 'high',  // Context-aware: drops to 'medium' during maintenance window
    version: '1.0.0',
    handler: async (input, auth) => {
      // Handler creates patch job via existing patchJobs infrastructure
      // Risk engine will check maintenance window context
    },
  });
}
```

### 1.1.3 Tool schema versioning

```typescript
// brain/types.ts

export interface BrainTool {
  definition: {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  };
  riskLevel: RiskLevel;
  version: string;                    // semver: '1.0.0'
  handler: (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;
  deprecated?: boolean;               // Soft deprecation flag
  replacedBy?: string;                // Name of replacement tool
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  riskLevel: RiskLevel;
  version: string;
  deprecated?: boolean;
  replacedBy?: string;
}

export interface ToolCatalog {
  version: string;                    // Catalog version (bumped on any tool change)
  tools: ToolCatalogEntry[];
  riskPolicy: RiskPolicy;
  capabilities: string[];            // Feature flags: ['patching', 'discovery', 'backup', ...]
}
```

**Versioning rules**:
- Tool added → catalog minor version bump
- Tool schema changed (backward compat) → tool patch version bump
- Tool schema changed (breaking) → tool major version bump, old version deprecated
- Tool removed → deprecated first, removed in next major catalog version

---

## 1.2 Risk Classification Engine

**Goal**: Evolve the existing 4-tier guardrails into a configurable, context-aware risk engine. The tier numbers become named risk levels. MSP admins can customize per-org.

### 1.2.1 Tier → Risk Level mapping

| Old Tier | New Risk Level | Behavior |
|---------|---------------|----------|
| Tier 1 | `low` | Auto-execute, no notification |
| Tier 2 | `medium` | Auto-execute, notify tech |
| Tier 3 | `high` | Requires approval before execution |
| Tier 4 | `critical` | Blocked entirely, manual only |

### 1.2.2 Risk classifier

```typescript
// brain/risk/classifier.ts

export interface RiskClassification {
  level: RiskLevel;
  reasons: string[];                   // Why this risk level was assigned
  contextFactors: string[];            // What context was considered
  overrideSource?: 'default' | 'org_policy' | 'context';
}

export function classifyRisk(
  toolName: string,
  input: Record<string, unknown>,
  context: RiskContext
): RiskClassification {
  // 1. Start with tool's default risk level
  const tool = getToolByName(toolName);
  let level = tool.riskLevel;
  const reasons: string[] = [`Default risk for ${toolName}: ${level}`];
  const contextFactors: string[] = [];

  // 2. Check action-based escalation (existing pattern from guardrails)
  const actionLevel = getActionRiskLevel(toolName, input.action as string);
  if (actionLevel && RISK_ORDER[actionLevel] > RISK_ORDER[level]) {
    level = actionLevel;
    reasons.push(`Action '${input.action}' escalates to ${actionLevel}`);
  }

  // 3. Check bulk threshold
  const deviceIds = input.device_ids as string[] | undefined;
  if (deviceIds && deviceIds.length > context.bulkThreshold) {
    level = escalateOneLevel(level);
    reasons.push(`Bulk operation (${deviceIds.length} devices > threshold ${context.bulkThreshold})`);
    contextFactors.push('bulk_threshold');
  }

  // 4. Check maintenance window
  if (context.isInMaintenanceWindow && RISK_ORDER[level] === RISK_ORDER['high']) {
    level = 'medium';
    reasons.push('During maintenance window — downgraded from high to medium');
    contextFactors.push('maintenance_window');
  }

  // 5. Check org-specific policy overrides
  const orgOverride = context.orgPolicy?.toolOverrides?.[toolName];
  if (orgOverride) {
    level = orgOverride.riskLevel;
    reasons.push(`Org policy override: ${orgOverride.riskLevel}`);
    contextFactors.push('org_policy');
  }

  // 6. Time-of-day context (optional)
  if (context.isBusinessHours && isDisruptiveAction(toolName, input)) {
    if (RISK_ORDER[level] < RISK_ORDER['high']) {
      level = escalateOneLevel(level);
      reasons.push('Disruptive action during business hours — escalated');
      contextFactors.push('business_hours');
    }
  }

  return { level, reasons, contextFactors };
}

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function escalateOneLevel(level: RiskLevel): RiskLevel {
  const levels: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  const idx = levels.indexOf(level);
  return levels[Math.min(idx + 1, 3)];
}
```

### 1.2.3 Risk context builder

```typescript
// brain/risk/context.ts

export interface RiskContext {
  orgId: string;
  bulkThreshold: number;              // Default: 5
  isInMaintenanceWindow: boolean;
  isBusinessHours: boolean;
  orgPolicy: OrgRiskPolicy | null;
  brainType: BrainType;               // 'byok' or 'lanternops'
}

export async function buildRiskContext(orgId: string, brainType: BrainType): Promise<RiskContext> {
  // 1. Load org risk policy (if customized)
  const orgPolicy = await db.select()
    .from(riskPolicies)
    .where(eq(riskPolicies.orgId, orgId))
    .limit(1)
    .then(rows => rows[0] ?? null);

  // 2. Check maintenance windows
  const now = new Date();
  const activeWindow = await db.select()
    .from(maintenance)
    .where(and(
      eq(maintenance.orgId, orgId),
      lte(maintenance.startTime, now),
      gte(maintenance.endTime, now),
    ))
    .limit(1);

  // 3. Business hours (from org settings or default 8am-6pm local)
  const isBusinessHours = checkBusinessHours(orgPolicy?.businessHours);

  return {
    orgId,
    bulkThreshold: orgPolicy?.bulkThreshold ?? 5,
    isInMaintenanceWindow: activeWindow.length > 0,
    isBusinessHours,
    orgPolicy,
    brainType,
  };
}
```

### 1.2.4 Risk policy DB schema

```typescript
// apps/api/src/db/schema/brain.ts (new file — or add to existing ai.ts)

export const riskPolicies = pgTable('risk_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),

  // Global overrides
  bulkThreshold: integer('bulk_threshold').default(5),
  businessHoursStart: varchar('business_hours_start', { length: 5 }).default('08:00'),
  businessHoursEnd: varchar('business_hours_end', { length: 5 }).default('18:00'),
  businessHoursTimezone: varchar('business_hours_timezone', { length: 50 }).default('UTC'),

  // Per-tool overrides: { "deploy_patches": { "riskLevel": "medium" }, ... }
  toolOverrides: jsonb('tool_overrides').$type<Record<string, { riskLevel: RiskLevel }>>(),

  // Per-action overrides: { "reboot": { "riskLevel": "critical" }, ... }
  actionOverrides: jsonb('action_overrides').$type<Record<string, { riskLevel: RiskLevel }>>(),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgIdx: uniqueIndex('risk_policies_org_idx').on(table.orgId),
}));
```

### 1.2.5 Admin UI for risk policy

```
Settings → Brain → Risk Policy

┌─────────────────────────────────────────────────────────────┐
│ Risk Policy for [Org Name]                                  │
│                                                             │
│ Bulk Operation Threshold: [5] devices                       │
│ (Actions targeting more than this many devices              │
│  are escalated one risk level)                              │
│                                                             │
│ Business Hours: [08:00] - [18:00] [UTC ▼]                  │
│ (Disruptive actions during business hours are escalated)    │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Tool Overrides                                          │ │
│ │                                                         │ │
│ │ deploy_patches    [high ▼]   (default: high)            │ │
│ │ run_script        [high ▼]   (default: high)            │ │
│ │ reboot            [medium ▼] (default: medium)          │ │
│ │ shutdown          [critical ▼] (default: high)          │ │
│ │ wipe              [critical ▼] (default: critical)      │ │
│ │                                                         │ │
│ │ [+ Add Override]                                        │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ [Save]  [Reset to Defaults]                                 │
└─────────────────────────────────────────────────────────────┘
```

### 1.2.6 Risk policy routes

```typescript
// brain/routes.ts

// GET /brain/risk-policy — get current policy for org
brainRoutes.get('/risk-policy', authMiddleware, async (c) => {
  const auth = c.get('auth');
  const policy = await getRiskPolicy(auth.orgId);
  const defaults = getDefaultRiskClassifications();
  return c.json({ policy, defaults });
});

// PUT /brain/risk-policy — update policy (admin only)
brainRoutes.put('/risk-policy', authMiddleware, requireScope('partner', 'system'), async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json();
  // Validate: can't downgrade 'critical' tools below 'high'
  validateRiskPolicyUpdate(body);
  const policy = await upsertRiskPolicy(auth.orgId, body);
  await writeRouteAudit(c, 'brain.risk_policy.update', { changes: body });
  return c.json({ success: true, policy });
});
```

### 1.2.7 Integration with engine

```typescript
// brain/engine.ts — modify the existing agentic loop

// Replace:
//   const tier = getToolTier(toolName);
//   if (tier >= 3) { /* approval flow */ }

// With:
const riskContext = await buildRiskContext(auth.orgId, brainType);
const risk = classifyRisk(toolName, input, riskContext);

switch (risk.level) {
  case 'low':
    // Auto-execute, no notification
    result = await executeTool(toolName, input, auth);
    break;
  case 'medium':
    // Auto-execute + notify
    result = await executeTool(toolName, input, auth);
    await notifyTechOfAction(auth.orgId, toolName, input, result, risk);
    break;
  case 'high':
    // Requires approval (existing flow from ai_tool_executions)
    yield { type: 'approval_required', executionId, toolName, input, risk };
    result = await waitForApproval(executionId);
    break;
  case 'critical':
    // Blocked
    result = JSON.stringify({
      status: 'blocked',
      riskLevel: 'critical',
      reason: 'This action requires manual execution via the RMM dashboard.',
      reasons: risk.reasons,
    });
    break;
}
```

---

## 1.3 Approval Workflow Engine

**Goal**: Extend the existing `ai_tool_executions` approval flow with notification dispatch, expiration, parameter modification, and a dedicated approvals queue.

### 1.3.1 Schema additions

```typescript
// Add columns to existing ai_tool_executions table

export const aiToolExecutions = pgTable('ai_tool_executions', {
  // ... existing columns ...

  // New columns for brain approvals
  riskLevel: varchar('risk_level', { length: 20 }),          // 'low'|'medium'|'high'|'critical'
  riskReasons: jsonb('risk_reasons').$type<string[]>(),       // Why this risk level
  brainType: varchar('brain_type', { length: 20 }),           // 'byok'|'lanternops'
  expiresAt: timestamp('expires_at'),                         // Approval expiration (default: +4h)
  modifiedInput: jsonb('modified_input'),                     // Tech-modified parameters
  modifiedBy: uuid('modified_by').references(() => users.id), // Who modified
  notificationSent: boolean('notification_sent').default(false),
  notificationChannels: jsonb('notification_channels').$type<string[]>(), // ['slack', 'email']
});
```

### 1.3.2 Approval manager

```typescript
// brain/approvals/manager.ts

export async function createApprovalRequest(params: {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  riskClassification: RiskClassification;
  orgId: string;
  brainType: BrainType;
}): Promise<string> {
  const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4 hours

  const [execution] = await db.insert(aiToolExecutions).values({
    id: crypto.randomUUID(),
    sessionId: params.sessionId,
    toolName: params.toolName,
    toolInput: params.toolInput,
    status: 'pending',
    riskLevel: params.riskClassification.level,
    riskReasons: params.riskClassification.reasons,
    brainType: params.brainType,
    expiresAt,
  }).returning();

  // Dispatch notifications
  await dispatchApprovalNotifications(execution, params.orgId);

  return execution.id;
}

export async function respondToApproval(params: {
  executionId: string;
  approved: boolean;
  responderId: string;
  modifiedInput?: Record<string, unknown>;
  notes?: string;
}): Promise<{ status: string; execution: typeof aiToolExecutions.$inferSelect }> {
  const execution = await db.select()
    .from(aiToolExecutions)
    .where(eq(aiToolExecutions.id, params.executionId))
    .limit(1)
    .then(rows => rows[0]);

  if (!execution) throw new Error('Approval not found');
  if (execution.status !== 'pending') throw new Error(`Already ${execution.status}`);
  if (execution.expiresAt && execution.expiresAt < new Date()) {
    await db.update(aiToolExecutions)
      .set({ status: 'expired' })
      .where(eq(aiToolExecutions.id, params.executionId));
    throw new Error('Approval expired');
  }

  const status = params.approved ? 'approved' : 'rejected';
  const [updated] = await db.update(aiToolExecutions)
    .set({
      status,
      approvedBy: params.responderId,
      approvedAt: new Date(),
      modifiedInput: params.modifiedInput ?? null,
      modifiedBy: params.modifiedInput ? params.responderId : null,
    })
    .where(eq(aiToolExecutions.id, params.executionId))
    .returning();

  return { status, execution: updated };
}

export async function expireStaleApprovals(): Promise<number> {
  // Called by a BullMQ cron job every 5 minutes
  const result = await db.update(aiToolExecutions)
    .set({ status: 'expired' })
    .where(and(
      eq(aiToolExecutions.status, 'pending'),
      lt(aiToolExecutions.expiresAt, new Date()),
    ));
  return result.rowCount ?? 0;
}
```

### 1.3.3 Notification dispatch

```typescript
// brain/approvals/manager.ts (continued)

async function dispatchApprovalNotifications(
  execution: typeof aiToolExecutions.$inferSelect,
  orgId: string
): Promise<void> {
  // Load org notification channels
  const channels = await db.select()
    .from(notificationChannels)
    .where(and(
      eq(notificationChannels.orgId, orgId),
      eq(notificationChannels.enabled, true),
    ));

  const message = {
    title: `Brain Action Requires Approval`,
    body: `**${execution.toolName}** — Risk: ${execution.riskLevel}\n${(execution.riskReasons as string[])?.join(', ')}`,
    action_url: `/approvals/${execution.id}`,
    urgency: execution.riskLevel === 'high' ? 'high' : 'normal',
  };

  // Use existing notification dispatch infrastructure
  for (const channel of channels) {
    switch (channel.type) {
      case 'slack':
        await sendSlackNotification(channel.config, message);
        break;
      case 'email':
        await sendEmailNotification(channel.config, message);
        break;
      case 'webhook':
        await sendWebhookNotification(channel.config, message);
        break;
      // teams, pagerduty, sms — same pattern
    }
  }

  await db.update(aiToolExecutions)
    .set({ notificationSent: true, notificationChannels: channels.map(c => c.type) })
    .where(eq(aiToolExecutions.id, execution.id));
}
```

### 1.3.4 Approval routes

```typescript
// brain/approvals/routes.ts

export const approvalRoutes = new Hono();

// GET /brain/approvals — list pending approvals for org
approvalRoutes.get('/', authMiddleware, async (c) => {
  const auth = c.get('auth');
  const status = c.req.query('status') ?? 'pending';

  const approvals = await db.select({
    execution: aiToolExecutions,
    sessionTitle: aiSessions.title,
  })
    .from(aiToolExecutions)
    .innerJoin(aiSessions, eq(aiToolExecutions.sessionId, aiSessions.id))
    .where(and(
      auth.orgCondition(aiSessions.orgId),
      eq(aiToolExecutions.status, status),
      isNotNull(aiToolExecutions.riskLevel),  // Only brain approvals
    ))
    .orderBy(desc(aiToolExecutions.createdAt))
    .limit(50);

  return c.json({ data: approvals });
});

// GET /brain/approvals/:id — get approval details
approvalRoutes.get('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const execution = await getApprovalDetails(id, c.get('auth'));
  return c.json(execution);
});

// POST /brain/approvals/:id/respond — approve/reject/modify
approvalRoutes.post('/:id/respond', authMiddleware, zValidator('json', approvalResponseSchema), async (c) => {
  const id = c.req.param('id');
  const auth = c.get('auth');
  const body = c.req.valid('json');

  const result = await respondToApproval({
    executionId: id,
    approved: body.approved,
    responderId: auth.userId,
    modifiedInput: body.modifiedInput,
    notes: body.notes,
  });

  await writeRouteAudit(c, `brain.approval.${result.status}`, {
    executionId: id,
    toolName: result.execution.toolName,
  });

  return c.json({ success: true, status: result.status });
});
```

### 1.3.5 Approval expiration cron

```typescript
// apps/api/src/jobs/brainJobs.ts (new file)

import { Queue, Worker } from 'bullmq';

const brainQueue = new Queue('brain', { connection: redis });

// Schedule: expire stale approvals every 5 minutes
await brainQueue.add('expire-approvals', {}, {
  repeat: { every: 5 * 60 * 1000 },
});

const brainWorker = new Worker('brain', async (job) => {
  switch (job.name) {
    case 'expire-approvals':
      const expired = await expireStaleApprovals();
      if (expired > 0) console.log(`Expired ${expired} stale brain approvals`);
      break;
  }
}, { connection: redis });
```

### 1.3.6 Dashboard widget

```
Brain Approvals Queue (pending: 2)
┌──────────────────────────────────────────────────────┐
│ ⚠ deploy_patches — 3 devices, KB5034441              │
│   Risk: HIGH — Outside maintenance window            │
│   Requested: 2 min ago  Expires: 3h 58m              │
│   [Approve] [Modify] [Reject]                        │
├──────────────────────────────────────────────────────┤
│ ⚠ run_script — ACME-DC01                             │
│   Risk: HIGH — Script modifies system state          │
│   Requested: 15 min ago  Expires: 3h 45m             │
│   [Approve] [Modify] [Reject]                        │
└──────────────────────────────────────────────────────┘
```

---

## 1.4 Brain Authentication & Registration

**Goal**: Brain-specific auth that supports both BYOK (local) and LanternOps (remote). Follows the existing API key pattern.

### 1.4.1 Schema

```typescript
// apps/api/src/db/schema/brain.ts

export const brainSessions = pgTable('brain_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),

  brainType: varchar('brain_type', { length: 20 }).notNull(),  // 'byok' | 'lanternops'
  status: varchar('status', { length: 20 }).notNull().default('active'),

  // Auth
  tokenHash: varchar('token_hash', { length: 255 }).notNull(), // SHA-256 of session token
  tokenPrefix: varchar('token_prefix', { length: 10 }).notNull(),

  // Scope
  authorizedTenants: jsonb('authorized_tenants').$type<string[]>(), // Org IDs this brain can access
  toolPermissions: jsonb('tool_permissions').$type<string[]>(),     // null = all tools

  // Metadata
  label: varchar('label', { length: 255 }),          // "BYOK - Production" or "LanternOps"
  remoteEndpoint: varchar('remote_endpoint', { length: 500 }), // LanternOps callback URL
  lastSeenAt: timestamp('last_seen_at'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at'),                // null = no expiry
  revokedAt: timestamp('revoked_at'),
}, (table) => ({
  tokenHashIdx: uniqueIndex('brain_sessions_token_hash_idx').on(table.tokenHash),
  orgIdx: index('brain_sessions_org_idx').on(table.orgId),
}));
```

### 1.4.2 Registration endpoint

```typescript
// brain/auth/registration.ts

// POST /brain/register
// Called once when connecting a brain to this RMM.
// For BYOK: during setup wizard.
// For LanternOps: during OAuth callback.

export async function registerBrain(params: {
  orgId: string;
  brainType: BrainType;
  label?: string;
  authorizedTenants?: string[];
  remoteEndpoint?: string;          // LanternOps only
}): Promise<{
  sessionToken: string;
  catalog: ToolCatalog;
  riskPolicy: RiskPolicy;
}> {
  // Generate token: brn_<random>
  const token = `brn_${crypto.randomBytes(32).toString('hex')}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const tokenPrefix = token.substring(0, 8);

  await db.insert(brainSessions).values({
    orgId: params.orgId,
    brainType: params.brainType,
    tokenHash,
    tokenPrefix,
    label: params.label ?? `${params.brainType} brain`,
    authorizedTenants: params.authorizedTenants,
    remoteEndpoint: params.remoteEndpoint,
  });

  return {
    sessionToken: token,              // Only returned once, never stored in plaintext
    catalog: getToolCatalog(),
    riskPolicy: await getRiskPolicy(params.orgId),
  };
}
```

### 1.4.3 Brain auth middleware

```typescript
// brain/auth/brainAuth.ts

export async function brainAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer brn_')) {
    // Fall through to regular auth (JWT or API key)
    return next();
  }

  const token = authHeader.replace('Bearer ', '');
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const session = await db.select()
    .from(brainSessions)
    .where(and(
      eq(brainSessions.tokenHash, tokenHash),
      eq(brainSessions.status, 'active'),
      isNull(brainSessions.revokedAt),
    ))
    .limit(1)
    .then(rows => rows[0]);

  if (!session) {
    return c.json({ error: 'Invalid brain token' }, 401);
  }

  if (session.expiresAt && session.expiresAt < new Date()) {
    return c.json({ error: 'Brain session expired' }, 401);
  }

  // Rate limit: 120 req/min per brain session
  const limited = await rateLimiter(redis, `brain:${session.id}`, 120, 60);
  if (limited) {
    return c.json({ error: 'Rate limited' }, 429);
  }

  // Update last seen (async, non-blocking)
  db.update(brainSessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(brainSessions.id, session.id))
    .execute()
    .catch(() => {}); // Fire and forget

  // Set auth context
  c.set('brain', {
    sessionId: session.id,
    orgId: session.orgId,
    brainType: session.brainType,
    authorizedTenants: session.authorizedTenants,
    toolPermissions: session.toolPermissions,
  });

  return next();
}
```

### 1.4.4 Registration routes

```typescript
// brain/auth/routes.ts

// POST /brain/register — register a new brain connection
brainAuthRoutes.post('/register', authMiddleware, requireScope('partner', 'system'), async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json();
  // Only admins can register brains
  const result = await registerBrain({
    orgId: auth.orgId,
    brainType: body.brainType,
    label: body.label,
    authorizedTenants: body.authorizedTenants,
    remoteEndpoint: body.remoteEndpoint,
  });
  await writeRouteAudit(c, 'brain.register', { brainType: body.brainType });
  return c.json(result);
});

// GET /brain/sessions — list brain connections for org
brainAuthRoutes.get('/sessions', authMiddleware, async (c) => {
  const auth = c.get('auth');
  const sessions = await db.select({
    id: brainSessions.id,
    brainType: brainSessions.brainType,
    status: brainSessions.status,
    label: brainSessions.label,
    tokenPrefix: brainSessions.tokenPrefix,
    lastSeenAt: brainSessions.lastSeenAt,
    createdAt: brainSessions.createdAt,
  })
    .from(brainSessions)
    .where(eq(brainSessions.orgId, auth.orgId))
    .orderBy(desc(brainSessions.createdAt));
  return c.json({ data: sessions });
});

// DELETE /brain/sessions/:id — revoke a brain connection
brainAuthRoutes.delete('/sessions/:id', authMiddleware, requireScope('partner', 'system'), async (c) => {
  const id = c.req.param('id');
  await db.update(brainSessions)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(eq(brainSessions.id, id));
  await writeRouteAudit(c, 'brain.session.revoke', { sessionId: id });
  return c.json({ success: true });
});
```

---

## 1.5 Event Emission System

**Goal**: Bridge existing alerts, monitors, and agent events into structured events that a brain can subscribe to and react to.

### 1.5.1 Event envelope

```typescript
// brain/events/envelope.ts

export interface BrainEvent {
  eventId: string;                     // UUID
  eventType: BrainEventType;
  timestamp: string;                   // ISO 8601
  orgId: string;
  deviceId?: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: 'security' | 'performance' | 'hardware' | 'software' | 'compliance' | 'connectivity';
  summary: string;                     // Human-readable one-liner
  details: Record<string, unknown>;    // Event-type-specific payload
  relatedEvents?: string[];            // IDs of correlated events
  suggestedTools?: string[];           // Tool names the brain might want to call
}

export type BrainEventType =
  | 'alert_triggered'
  | 'alert_resolved'
  | 'patch_failed'
  | 'patch_available'
  | 'performance_threshold'
  | 'security_event'
  | 'device_offline'
  | 'device_online'
  | 'software_installed'
  | 'software_removed'
  | 'policy_violation'
  | 'service_stopped'
  | 'backup_failed'
  | 'discovery_completed';
```

### 1.5.2 Event emitter

```typescript
// brain/events/emitter.ts

import { EventEmitter } from 'events';

class BrainEventBus extends EventEmitter {
  emit(event: 'brain_event', data: BrainEvent): boolean {
    return super.emit('brain_event', data);
  }

  subscribe(
    orgIds: string[],
    callback: (event: BrainEvent) => void,
    filters?: { severity?: string[]; category?: string[]; eventTypes?: string[] }
  ): () => void {
    const handler = (event: BrainEvent) => {
      if (!orgIds.includes(event.orgId)) return;
      if (filters?.severity && !filters.severity.includes(event.severity)) return;
      if (filters?.category && !filters.category.includes(event.category)) return;
      if (filters?.eventTypes && !filters.eventTypes.includes(event.eventType)) return;
      callback(event);
    };

    this.on('brain_event', handler);
    return () => this.off('brain_event', handler);
  }
}

export const brainEventBus = new BrainEventBus();
```

### 1.5.3 Integration points — emit events from existing systems

These are lightweight hooks into existing code. Each is a single function call added to existing handlers.

```typescript
// Hook 1: Alert triggered → brain event
// In: apps/api/src/services/alertEvaluator.ts (or wherever alerts are created)

import { brainEventBus } from '../brain/events/emitter';
import { alertToBrainEvent } from '../brain/events/adapters';

// After creating an alert:
async function onAlertTriggered(alert: Alert, device: Device) {
  // ... existing alert creation logic ...

  // Emit brain event
  brainEventBus.emit('brain_event', alertToBrainEvent(alert, device));
}
```

```typescript
// brain/events/adapters.ts — convert existing data into BrainEvent envelopes

export function alertToBrainEvent(alert: Alert, device?: Device): BrainEvent {
  return {
    eventId: crypto.randomUUID(),
    eventType: 'alert_triggered',
    timestamp: new Date().toISOString(),
    orgId: alert.orgId,
    deviceId: alert.deviceId ?? undefined,
    severity: alert.severity,
    category: mapAlertCategoryToBrainCategory(alert.category),
    summary: alert.title,
    details: {
      alertId: alert.id,
      ruleId: alert.ruleId,
      message: alert.message,
      metricValue: alert.metricValue,
      threshold: alert.threshold,
    },
    suggestedTools: suggestToolsForAlert(alert),
  };
}

export function patchFailureToBrainEvent(patchJob: PatchJob, device: Device): BrainEvent {
  return {
    eventId: crypto.randomUUID(),
    eventType: 'patch_failed',
    timestamp: new Date().toISOString(),
    orgId: device.orgId,
    deviceId: device.id,
    severity: 'high',
    category: 'software',
    summary: `Patch ${patchJob.patchTitle} failed on ${device.hostname}`,
    details: {
      patchId: patchJob.patchId,
      patchTitle: patchJob.patchTitle,
      errorCode: patchJob.errorCode,
      errorMessage: patchJob.errorMessage,
    },
    suggestedTools: ['get_device_details', 'get_patch_status', 'run_script'],
  };
}

export function deviceStatusToBrainEvent(device: Device, newStatus: string): BrainEvent {
  return {
    eventId: crypto.randomUUID(),
    eventType: newStatus === 'offline' ? 'device_offline' : 'device_online',
    timestamp: new Date().toISOString(),
    orgId: device.orgId,
    deviceId: device.id,
    severity: newStatus === 'offline' ? 'medium' : 'info',
    category: 'connectivity',
    summary: `${device.hostname} went ${newStatus}`,
    details: {
      previousStatus: device.status,
      lastSeen: device.lastSeen,
    },
    suggestedTools: newStatus === 'offline' ? ['get_device_details', 'get_monitors'] : [],
  };
}

function suggestToolsForAlert(alert: Alert): string[] {
  switch (alert.category) {
    case 'security': return ['get_device_details', 'run_script', 'manage_services'];
    case 'performance': return ['get_device_details', 'analyze_metrics'];
    case 'compliance': return ['get_device_details', 'get_patch_status'];
    default: return ['get_device_details'];
  }
}
```

### 1.5.4 WebSocket event stream

```typescript
// brain/events/stream.ts

// WebSocket /brain/events — brain subscribes to real-time events

export function setupBrainEventStream(app: Hono) {
  app.get('/brain/events', upgradeWebSocket((c) => {
    const brain = c.get('brain'); // Set by brainAuthMiddleware
    if (!brain) {
      return { onOpen: (_, ws) => ws.close(4001, 'Unauthorized') };
    }

    let unsubscribe: (() => void) | null = null;

    return {
      onOpen(event, ws) {
        const orgIds = brain.authorizedTenants ?? [brain.orgId];

        // Parse filters from query params
        const filters = {
          severity: c.req.query('severity')?.split(','),
          category: c.req.query('category')?.split(','),
          eventTypes: c.req.query('types')?.split(','),
        };

        unsubscribe = brainEventBus.subscribe(orgIds, (brainEvent) => {
          try {
            ws.send(JSON.stringify(brainEvent));
          } catch {
            // Client disconnected
          }
        }, filters);

        ws.send(JSON.stringify({ type: 'connected', orgIds, filters }));
      },

      onMessage(event, ws) {
        // Brain can send: ping, update_filters
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch {}
      },

      onClose() {
        unsubscribe?.();
      },
    };
  }));
}
```

### 1.5.5 Event aggregator (high-volume protection)

```typescript
// brain/events/aggregator.ts

// Prevents flooding the brain with 100+ events/minute during incidents.
// Batches similar events and emits a summary.

interface EventBuffer {
  events: BrainEvent[];
  firstSeen: number;
  lastSeen: number;
}

const eventBuffers = new Map<string, EventBuffer>();
const BATCH_WINDOW_MS = 30_000;  // 30 seconds
const BATCH_THRESHOLD = 5;        // Aggregate after 5 similar events

export function aggregatedEmit(event: BrainEvent): void {
  const key = `${event.orgId}:${event.eventType}:${event.category}`;

  const buffer = eventBuffers.get(key);
  if (!buffer) {
    // First event of this type — emit immediately, start buffer
    brainEventBus.emit('brain_event', event);
    eventBuffers.set(key, {
      events: [event],
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    });
    return;
  }

  buffer.events.push(event);
  buffer.lastSeen = Date.now();

  // If buffer window expired, flush
  if (Date.now() - buffer.firstSeen > BATCH_WINDOW_MS) {
    flushBuffer(key, buffer);
    return;
  }

  // If threshold reached, emit summary
  if (buffer.events.length >= BATCH_THRESHOLD) {
    flushBuffer(key, buffer);
  }
}

function flushBuffer(key: string, buffer: EventBuffer): void {
  if (buffer.events.length <= 1) {
    eventBuffers.delete(key);
    return;
  }

  // Emit aggregated event
  const first = buffer.events[0];
  brainEventBus.emit('brain_event', {
    eventId: crypto.randomUUID(),
    eventType: first.eventType,
    timestamp: new Date().toISOString(),
    orgId: first.orgId,
    severity: getHighestSeverity(buffer.events),
    category: first.category,
    summary: `${buffer.events.length} ${first.eventType} events in ${Math.round((buffer.lastSeen - buffer.firstSeen) / 1000)}s`,
    details: {
      count: buffer.events.length,
      deviceIds: [...new Set(buffer.events.map(e => e.deviceId).filter(Boolean))],
      firstEvent: first.details,
      window: {
        start: new Date(buffer.firstSeen).toISOString(),
        end: new Date(buffer.lastSeen).toISOString(),
      },
    },
    suggestedTools: [...new Set(buffer.events.flatMap(e => e.suggestedTools ?? []))],
  });

  eventBuffers.delete(key);
}

// Flush stale buffers every 30s
setInterval(() => {
  const now = Date.now();
  for (const [key, buffer] of eventBuffers) {
    if (now - buffer.firstSeen > BATCH_WINDOW_MS) {
      flushBuffer(key, buffer);
    }
  }
}, BATCH_WINDOW_MS);
```

### 1.5.6 Integration hooks — where to call `aggregatedEmit()`

| Existing Code Location | Event Type | Hook Point |
|------------------------|-----------|------------|
| Alert evaluator (when alert fires) | `alert_triggered` | After `db.insert(alerts)` |
| Alert resolver | `alert_resolved` | After `db.update(alerts).set({ status: 'resolved' })` |
| Patch job worker (on failure) | `patch_failed` | In BullMQ worker `catch` block |
| Patch sync (new patches available) | `patch_available` | After syncing from upstream |
| Agent heartbeat (status change) | `device_offline` / `device_online` | In `agentWs.ts` `onClose` / `onOpen` |
| Monitor check (threshold breach) | `performance_threshold` | In monitor evaluation worker |
| Service status change | `service_stopped` | In agent `command_result` for service check |
| Backup job (on failure) | `backup_failed` | In backup BullMQ worker |
| Discovery scan complete | `discovery_completed` | In `processOrphanedCommandResult` |

Each hook is **one function call** added to existing code — no restructuring required.

---

## Implementation Order

```
Week 1-2: Phase 1.0 (Retrofit)
├── Create brain/ directory structure
├── Move + rename files (aiAgent → engine, aiTools → registry, etc.)
├── Add route aliases (/brain/* alongside /ai/*)
├── Split tool definitions into per-group files
├── Update imports throughout codebase
├── Verify all existing functionality works
└── Update shared types (brain.ts)

Week 2-3: Phase 1.1 (Tool Catalog)
├── Add version field to tool definitions
├── Implement GET /brain/catalog endpoint
├── Register new tools (patches, monitors, discovery, reports)
├── Write tool handler implementations
└── Add catalog version tracking

Week 3-4: Phase 1.2 (Risk Engine)
├── Create riskPolicies schema + migration
├── Implement classifier with context awareness
├── Build risk context (maintenance windows, business hours, bulk threshold)
├── Replace tier checks in engine with risk classification
├── Risk policy CRUD routes
└── Admin UI for risk policy editor

Week 4-5: Phase 1.3 (Approvals)
├── Add columns to ai_tool_executions (risk fields, expiration, modification)
├── Implement approval manager with notification dispatch
├── Approval routes (list, get, respond)
├── Approval expiration cron job
├── Dashboard approval queue widget
└── Modify approval UX for tech-modified parameters

Week 5-6: Phase 1.4 (Brain Auth)
├── Create brainSessions schema + migration
├── Implement registration endpoint
├── Brain auth middleware (Bearer brn_ tokens)
├── Brain session management routes (list, revoke)
├── Rate limiting per brain session
└── Settings UI: brain connection management

Week 6-7: Phase 1.5 (Event System)
├── Define event envelope types
├── Implement event bus (EventEmitter)
├── Write event adapters (alert → event, patch → event, etc.)
├── Add emit hooks to existing systems (one call per integration point)
├── Implement WebSocket event stream with auth
├── Build event aggregator for high-volume protection
└── Test with real alert/monitor triggers

Week 7-8: Integration Testing & Polish
├── End-to-end: trigger alert → event emitted → brain receives via WS
├── End-to-end: brain calls tool → risk check → approval → execution
├── Load test: 100+ events/minute aggregation
├── MCP server updated to use new tool catalog
├── Documentation: brain connector API reference
└── Frontend: brain status indicators, event log viewer
```

---

## Migration Strategy

### Database Migrations

```sql
-- Migration 1: risk_policies table
CREATE TABLE risk_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  bulk_threshold INT DEFAULT 5,
  business_hours_start VARCHAR(5) DEFAULT '08:00',
  business_hours_end VARCHAR(5) DEFAULT '18:00',
  business_hours_timezone VARCHAR(50) DEFAULT 'UTC',
  tool_overrides JSONB,
  action_overrides JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(org_id)
);

-- Migration 2: brain_sessions table
CREATE TABLE brain_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  brain_type VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  token_prefix VARCHAR(10) NOT NULL,
  authorized_tenants JSONB,
  tool_permissions JSONB,
  label VARCHAR(255),
  remote_endpoint VARCHAR(500),
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX brain_sessions_org_idx ON brain_sessions(org_id);

-- Migration 3: add columns to ai_tool_executions
ALTER TABLE ai_tool_executions
  ADD COLUMN risk_level VARCHAR(20),
  ADD COLUMN risk_reasons JSONB,
  ADD COLUMN brain_type VARCHAR(20),
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD COLUMN modified_input JSONB,
  ADD COLUMN modified_by UUID REFERENCES users(id),
  ADD COLUMN notification_sent BOOLEAN DEFAULT FALSE,
  ADD COLUMN notification_channels JSONB;
```

### Backward Compatibility

- `/api/ai/*` routes continue to work (aliases to `/api/brain/*`)
- Existing `aiSessions`, `aiMessages` tables are NOT renamed (avoid migration risk)
- New brain features use new tables (`brainSessions`, `riskPolicies`)
- Shared types export both old (`AiStreamEvent`) and new (`BrainStreamEvent`) names
- Frontend updated incrementally — old API calls work throughout

### Rollback Plan

Each sub-phase is independently deployable and reversible:
- 1.0 (retrofit): revert file moves, restore old imports
- 1.1 (catalog): new endpoint, no breaking changes
- 1.2 (risk): new table + classifier, old tier system as fallback
- 1.3 (approvals): additive columns, old flow still works
- 1.4 (brain auth): new table + middleware, doesn't affect existing auth
- 1.5 (events): new EventEmitter, hooks are single function calls, easy to remove

---

## Testing Plan

| Area | Test Type | Coverage |
|------|----------|----------|
| Tool catalog | Unit | Schema validation, version comparison, filtering |
| Risk classifier | Unit | All risk levels, context factors, escalation logic, org overrides |
| Approval manager | Unit | Create, respond, expire, modify, notification dispatch |
| Brain auth | Integration | Token generation, validation, rate limiting, revocation |
| Event emitter | Unit | Emit, subscribe, filter, unsubscribe |
| Event aggregator | Unit | Batching, threshold, window expiry, severity escalation |
| Event adapters | Unit | Alert→event, patch→event, device→event conversion |
| WebSocket stream | Integration | Connect, receive events, filter, disconnect |
| End-to-end | E2E | Alert triggers → event → brain receives → tool call → risk check → approval → execution |
| Backward compat | E2E | All existing /api/ai/* endpoints still work identically |
