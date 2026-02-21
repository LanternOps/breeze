// ============================================
// AI Approval Modes
// ============================================

export type AiApprovalMode = 'per_step' | 'action_plan' | 'auto_approve' | 'hybrid_plan';

export interface ActionPlanStep {
  index: number;
  toolName: string;
  input: Record<string, unknown>;
  reasoning: string;
  status?: 'pending' | 'executing' | 'completed' | 'failed' | 'skipped';
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

// ============================================
// SSE Event Types
// ============================================

export type AiStreamEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'content_delta'; delta: string }
  | { type: 'tool_use_start'; toolName: string; toolUseId: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; output: unknown; isError: boolean }
  | { type: 'approval_required'; executionId: string; toolName: string; input: Record<string, unknown>; description: string; deviceContext?: { hostname: string; displayName?: string; status: string; lastSeenAt?: string; activeSessions?: Array<{ username: string; activityState?: string; idleMinutes?: number; sessionType: string }> } }
  | { type: 'plan_approval_required'; planId: string; steps: ActionPlanStep[] }
  | { type: 'plan_step_start'; planId: string; stepIndex: number; toolName: string }
  | { type: 'plan_step_complete'; planId: string; stepIndex: number; toolName: string; isError: boolean }
  | { type: 'plan_complete'; planId: string; status: 'completed' | 'aborted' }
  | { type: 'plan_screenshot'; planId: string; stepIndex: number; imageBase64: string }
  | { type: 'approval_mode_changed'; mode: AiApprovalMode }
  | { type: 'title_updated'; title: string }
  | { type: 'message_end'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
  | { type: 'done' };

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
