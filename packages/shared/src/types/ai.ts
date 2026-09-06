// ============================================
// AI Approval Modes
// ============================================

export type AiApprovalMode = 'per_step' | 'action_plan' | 'auto_approve' | 'hybrid_plan';

/**
 * Tier-3 approval scope — the SINGLE declaration of this union for the whole
 * repo (spec docs/superpowers/specs/ai-mcp/2026-08-05-tier3-supervised-four-eyes-split-design.md).
 *
 * `supervised` — the requester approves their own AI action with a plain click,
 * gated on their existing RBAC. `four_eyes` — a second `approvals:decide`
 * holder must decide, with a shorter deadline and a pinned argument digest.
 *
 * Everything that needs the union imports it from here rather than re-typing
 * the literals: `apps/api/src/db/schema/actionIntents.ts` (column + enum),
 * `apps/api/src/services/aiGuardrails.ts` (resolveApprovalScope +
 * GuardrailCheck), and the `approval_required` SSE event below. Because
 * TypeScript is structural, four independent `'supervised' | 'four_eyes'`
 * literals would let a third member be added to one of them and compile clean
 * everywhere else — the dual-map drift class this repo has been bitten by
 * before. The SQL `CHECK (approval_scope IN (...))` in
 * `apps/api/migrations/2026-08-14-intent-approval-scope-and-deadlines.sql` is
 * pinned to AI_APPROVAL_SCOPES by a test in
 * `apps/api/src/db/schema/actionIntents.test.ts`.
 *
 * Deliberately NOT exposed as a Zod schema: approvalScope is never
 * client-supplied — it is derived server-side by checkGuardrails at intent
 * creation. A validator here would wrongly imply callers may pass it.
 */
export const AI_APPROVAL_SCOPES = ['supervised', 'four_eyes'] as const;
export type AiApprovalScope = (typeof AI_APPROVAL_SCOPES)[number];

export interface ActionPlanStep {
  toolName: string;
  input: Record<string, unknown>;
  reasoning: string;
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'skipped';
}

export interface ActionPlan {
  id: string;
  sessionId: string;
  status: 'pending' | 'approved' | 'rejected' | 'executing' | 'completed' | 'aborted';
  steps: ActionPlanStep[];
  currentStepIndex: number;
}

// ============================================
// AI Session & Message Types
// ============================================

export type AiSessionStatus = 'active' | 'closed' | 'expired';
export type AiMessageRole = 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
export type AiToolStatus = 'pending' | 'approved' | 'executing' | 'completed' | 'failed' | 'rejected';

export interface AiSession {
  id: string;
  orgId: string;
  userId: string;
  status: AiSessionStatus;
  title: string | null;
  model: string;
  contextSnapshot: AiPageContext | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostCents: number;
  turnCount: number;
  maxTurns: number;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AiMessage {
  id: string;
  sessionId: string;
  role: AiMessageRole;
  content: string | null;
  contentBlocks: AiContentBlock[] | null;
  toolName: string | null;
  toolInput: Record<string, unknown> | null;
  toolOutput: Record<string, unknown> | null;
  toolUseId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: Date;
}

export interface AiToolExecution {
  id: string;
  sessionId: string;
  messageId: string | null;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: Record<string, unknown> | null;
  status: AiToolStatus;
  approvedBy: string | null;
  approvedAt: Date | null;
  commandId: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

// ============================================
// Content Block Types (mirrors Anthropic API)
// ============================================

export type AiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

// ============================================
// Page Context (injected from frontend)
// ============================================

export type AiPageContext =
  | { type: 'device'; id: string; hostname: string; os?: string; status?: string; ip?: string }
  | { type: 'alert'; id: string; title: string; severity?: string; deviceHostname?: string }
  | { type: 'dashboard'; orgName?: string; deviceCount?: number; alertCount?: number }
  | { type: 'custom'; label: string; data: Record<string, unknown> };

export interface AiTicketDraft {
  subject: string;
  problemSummary: string;
  resolutionSummary: string;
  suggestedStatus: 'open' | 'resolved';
  suggestedTimeMinutes: number;
  elapsedMinutes: number;
  orgId: string;
  orgName: string | null;
  deviceId: string | null;
  deviceHostname: string | null;
}

// ============================================
// SSE Event Types
// ============================================

/**
 * Resolved run context for a script-launch approval (#4888).
 *
 * `effectiveRunAs` is what the run will actually execute as — the assistant's
 * override when it supplied one, otherwise the script's saved default. Null
 * only when the assistant chose nothing and the script row could not be read,
 * in which case the card falls back to "the script's saved run context".
 */
export interface AiScriptRunContext {
  effectiveRunAs: 'system' | 'user' | 'elevated' | null;
  scriptDefaultRunAs: 'system' | 'user' | 'elevated' | null;
  chosenByAssistant: boolean;
  targetSessionId: number | null;
}

export type AiStreamEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'content_delta'; delta: string }
  | { type: 'tool_use_start'; toolName: string; toolUseId: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; output: unknown; isError: boolean }
  /**
   * The run context an approver is being asked to authorise for a script
   * launch (#4888). Present only for `run_script` /
   * `execute_script_on_device`; null/absent for every other tool.
   *
   * Exists as a STRUCTURED twin of the sentence the server also appends to
   * `description`, so the web approval card can render a localized,
   * always-visible run-context row instead of parsing English prose or
   * leaving the value buried in the collapsed parameter JSON. Letting an
   * assistant choose SYSTEM for a user-context script is a privilege
   * decision, and the human deciding it has to be told.
   */
  | { type: 'approval_required'; executionId: string; approvalRequestId?: string; selfApprovalRequestId?: string; approvalScope?: AiApprovalScope; intentExpiresAt?: string; toolName: string; input: Record<string, unknown>; description: string; requiresAdminApproval?: boolean; deviceContext?: { hostname: string; displayName?: string; status: string; lastSeenAt?: string; activeSessions?: Array<{ username: string; activityState?: string; idleMinutes?: number; sessionType: string }> }; intentBacked?: boolean; scriptRunContext?: AiScriptRunContext | null }
  | { type: 'plan_approval_required'; planId: string; steps: ActionPlanStep[] }
  | { type: 'plan_step_start'; planId: string; stepIndex: number; toolName: string }
  | { type: 'plan_step_complete'; planId: string; stepIndex: number; toolName: string; isError: boolean }
  | { type: 'plan_complete'; planId: string; status: 'completed' | 'aborted' }
  | { type: 'plan_screenshot'; planId: string; stepIndex: number; imageBase64: string }
  | { type: 'approval_mode_changed'; mode: AiApprovalMode }
  | { type: 'title_updated'; title: string }
  | { type: 'message_end'; inputTokens: number; outputTokens: number }
  | { type: 'warning'; message: string; context?: string }
  | { type: 'error'; message: string }
  // ── Generic client-declared session tools (e.g. Helper chat) — published by
  //    services/clientSessionTools.ts when the model calls a client-declared tool.
  | { type: 'client_tool_request'; toolUseId: string; toolName: string; input: Record<string, unknown> }
  // ── AI for Office (client sessions) — published by the client tool bridge/handlers ──
  | { type: 'tool_request'; toolUseId: string; toolName: string; input: Record<string, unknown>; mutating: boolean }
  | {
      type: 'tool_completed';
      toolUseId: string;
      toolName: string;
      status: 'success' | 'error' | 'rejected' | 'timeout';
      redactions?: Array<{ rule: string; count: number; location: string }>;
      blockReason?: string;
    }
  // `usage` is set by the streaming manager's result case so client surfaces
  // can render turn cost (turn_complete). Technician UI ignores it.
  | { type: 'done'; usage?: { inputTokens: number; outputTokens: number; costCents: number } };

// ============================================
// API Request/Response Types
// ============================================

export interface CreateAiSessionRequest {
  pageContext?: AiPageContext;
  model?: string;
  title?: string;
}

export interface SendAiMessageRequest {
  content: string;
  pageContext?: AiPageContext;
}

export interface ApproveToolRequest {
  approved: boolean;
}

export interface AiUsageResponse {
  daily: {
    inputTokens: number;
    outputTokens: number;
    totalCostCents: number;
    messageCount: number;
  };
  monthly: {
    inputTokens: number;
    outputTokens: number;
    totalCostCents: number;
    messageCount: number;
  };
  budget: {
    enabled: boolean;
    monthlyBudgetCents: number | null;
    dailyBudgetCents: number | null;
    monthlyUsedCents: number;
    dailyUsedCents: number;
    approvalMode: AiApprovalMode;
  } | null;
}

// ============================================
// Tool Tier System
// ============================================

export type AiToolTier = 1 | 2 | 3 | 4;

export interface AiToolDefinition {
  name: string;
  description: string;
  tier: AiToolTier;
  inputSchema: Record<string, unknown>;
}

// ============================================
// Script Builder Types
// ============================================

// Re-export canonical types from index (avoid duplication)
import type { ScriptLanguage, OSType, ScriptRunAs } from './index';
export type { ScriptLanguage, OSType } from './index';
/** @deprecated Use `ScriptRunAs` from `@breeze/shared` directly */
export type RunAs = ScriptRunAs;

export interface ScriptBuilderContext {
  scriptId?: string;
  /** Device the user pinned in the editor for test runs. */
  targetDeviceId?: string;
  /** Most recent test-run execution started from the editor. */
  lastTestExecutionId?: string;
  editorSnapshot?: {
    name?: string;
    content?: string;
    description?: string;
    language?: ScriptLanguage;
    osTypes?: OSType[];
    category?: string;
    parameters?: Array<{
      name: string;
      type: 'string' | 'number' | 'boolean' | 'select';
      defaultValue?: string;
      required?: boolean;
      options?: string;
    }>;
    runAs?: ScriptRunAs;
    timeoutSeconds?: number;
  };
}
