import type { AiStreamEvent, AiApprovalMode, ActionPlanStep } from '@breeze/shared';

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  toolUseId?: string;
  isError?: boolean;
  isStreaming?: boolean;
  createdAt: Date;
}

export interface DeviceContext {
  hostname: string;
  displayName?: string;
  status: string;
  lastSeenAt?: string;
  activeSessions?: Array<{ username: string; activityState?: string; idleMinutes?: number; sessionType: string }>;
}

export interface PendingApproval {
  executionId: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  deviceContext?: DeviceContext;
}

export interface PendingPlan {
  planId: string;
  steps: ActionPlanStep[];
}

export interface ActivePlan {
  planId: string;
  steps: ActionPlanStep[];
  currentStepIndex: number;
  status: 'executing' | 'completed' | 'aborted';
}

/**
 * The subset of state that processStreamEvent needs to read and write.
 * Both aiStore (flat) and workspaceStore (per-tab) implement this shape.
 */
export interface StreamableState {
  messages: AiMessage[];
  pendingApproval: PendingApproval | null;
  pendingPlan: PendingPlan | null;
  activePlan: ActivePlan | null;
  approvalMode: AiApprovalMode;
  isPaused: boolean;
  isStreaming: boolean;
  error: string | null;
  sessionId: string | null;
  sessions: Array<{ id: string; title: string | null; status: string; createdAt: string }>;
}

type StreamSetter = (fn: (s: StreamableState) => Partial<StreamableState>) => void;
type StreamGetter = () => StreamableState;

export function processStreamEvent(
  event: AiStreamEvent,
  set: StreamSetter,
  get: StreamGetter,
  currentAssistantId: string | null
): string | null {
  switch (event.type) {
    case 'message_start': {
      const msg: AiMessage = {
        id: event.messageId,
        role: 'assistant',
        content: '',
        isStreaming: true,
        createdAt: new Date()
      };
      set((s) => ({ messages: [...s.messages, msg] }));
      return event.messageId;
    }

    case 'content_delta': {
      if (currentAssistantId) {
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === currentAssistantId
              ? { ...m, content: m.content + event.delta }
              : m
          )
        }));
      }
      return currentAssistantId;
    }

    case 'tool_use_start': {
      const toolMsg: AiMessage = {
        id: `tool-${event.toolUseId}`,
        role: 'tool_use',
        content: '',
        toolName: event.toolName,
        toolInput: event.input && Object.keys(event.input).length > 0 ? event.input : undefined,
        toolUseId: event.toolUseId,
        createdAt: new Date()
      };
      set((s) => ({ messages: [...s.messages, toolMsg] }));
      return currentAssistantId;
    }

    case 'tool_result': {
      const resultMsg: AiMessage = {
        id: `result-${event.toolUseId}`,
        role: 'tool_result',
        content: typeof event.output === 'string' ? event.output : JSON.stringify(event.output, null, 2),
        toolOutput: event.output as Record<string, unknown>,
        toolUseId: event.toolUseId,
        isError: event.isError,
        createdAt: new Date()
      };
      set((s) => ({ messages: [...s.messages, resultMsg] }));
      return currentAssistantId;
    }

    case 'approval_required':
      set(() => ({
        pendingApproval: {
          executionId: event.executionId,
          toolName: event.toolName,
          input: event.input,
          description: event.description,
          deviceContext: event.deviceContext,
        }
      }));
      return currentAssistantId;

    case 'title_updated':
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === s.sessionId ? { ...sess, title: event.title } : sess
        )
      }));
      return currentAssistantId;

    case 'message_end': {
      if (currentAssistantId) {
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === currentAssistantId ? { ...m, isStreaming: false } : m
          )
        }));
      }
      return null;
    }

    case 'error':
      set(() => ({ error: event.message, isStreaming: false }));
      return currentAssistantId;

    case 'plan_approval_required':
      set(() => ({
        pendingPlan: {
          planId: event.planId,
          steps: event.steps,
        },
      }));
      return currentAssistantId;

    case 'plan_step_start': {
      set((s) => ({
        activePlan: s.activePlan ? { ...s.activePlan, currentStepIndex: event.stepIndex } : s.activePlan,
      }));
      return currentAssistantId;
    }

    case 'plan_step_complete': {
      set((s) => {
        if (!s.activePlan) return {};
        const steps = s.activePlan.steps.map((step, i) =>
          i === event.stepIndex ? { ...step, status: event.isError ? 'failed' as const : 'completed' as const } : step
        );
        return { activePlan: { ...s.activePlan, steps, currentStepIndex: event.stepIndex + 1 } };
      });
      return currentAssistantId;
    }

    case 'plan_complete': {
      const completedPlanId = event.planId;
      set((s) => ({
        activePlan: s.activePlan ? { ...s.activePlan, status: event.status } : null,
      }));
      setTimeout(() => {
        const state = get();
        if (state.activePlan?.planId === completedPlanId) {
          set(() => ({ activePlan: null }));
        }
      }, 3000);
      return currentAssistantId;
    }

    case 'plan_screenshot': {
      const screenshotMsg: AiMessage = {
        id: `plan-screenshot-${event.planId}-${event.stepIndex}`,
        role: 'tool_result',
        content: '',
        toolName: 'plan_screenshot',
        toolOutput: { imageBase64: event.imageBase64, stepIndex: event.stepIndex },
        createdAt: new Date(),
      };
      set((s) => ({ messages: [...s.messages, screenshotMsg] }));
      return currentAssistantId;
    }

    case 'approval_mode_changed': {
      set(() => ({ approvalMode: event.mode, isPaused: event.mode === 'per_step' }));
      return currentAssistantId;
    }

    case 'done':
      set(() => ({ isStreaming: false }));
      return null;
  }

  return null;
}

/** Map raw API message objects to typed AiMessage array */
export function mapMessagesFromApi(rawMessages: Record<string, unknown>[]): AiMessage[] {
  return rawMessages.map((m) => ({
    id: m.id as string,
    role: m.role as AiMessage['role'],
    content: (m.content as string) ?? '',
    toolName: m.toolName as string | undefined,
    toolInput: m.toolInput as Record<string, unknown> | undefined,
    toolOutput: m.toolOutput,
    toolUseId: m.toolUseId as string | undefined,
    createdAt: new Date(m.createdAt as string)
  }));
}
