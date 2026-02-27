/**
 * Script Builder AI Zustand Store
 *
 * Manages state for the inline script editor AI assistant panel.
 * Uses a bridge pattern to communicate with the ScriptForm's
 * react-hook-form state without tight coupling.
 */

import { create } from 'zustand';
import { fetchWithAuth } from './auth';
import type {
  AiStreamEvent,
  ScriptBuilderContext,
  ScriptLanguage,
  OSType,
  ScriptRunAs,
} from '@breeze/shared';

// ============================================
// Types
// ============================================

export interface ScriptAiMessage {
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

/**
 * Shape of the ScriptForm state. Used both for live reads/writes
 * via the bridge and for point-in-time snapshots (revert/redo).
 * Mirrors the form shape used by react-hook-form in ScriptForm.
 */
export interface ScriptFormSnapshot {
  name?: string;
  description?: string;
  content?: string;
  language?: ScriptLanguage;
  category?: string;
  osTypes?: OSType[];
  parameters?: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'select';
    defaultValue?: string;
    required?: boolean;
    options?: string;
  }>;
  runAs?: ScriptRunAs;
  timeoutSeconds?: number;
}

/**
 * Bridge interface for the AI store to communicate with ScriptForm.
 * ScriptForm registers an implementation via `setBridge()`.
 */
export interface ScriptFormBridge {
  /** Read current form values */
  getFormValues: () => ScriptFormSnapshot;
  /** Write values into the form */
  setFormValues: (values: Partial<ScriptFormSnapshot>) => void;
  /** Take a snapshot of the current form state (for revert) */
  takeSnapshot: () => ScriptFormSnapshot;
  /** Restore a previously taken snapshot */
  restoreSnapshot: (snapshot: ScriptFormSnapshot) => void;
}

interface PendingApproval {
  executionId: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string;
}

interface ScriptAiState {
  // State
  sessionId: string | null;
  messages: ScriptAiMessage[];
  isStreaming: boolean;
  isLoading: boolean;
  error: string | null;
  pendingApproval: PendingApproval | null;
  panelOpen: boolean;
  hasApplied: boolean;
  hasReverted: boolean;
  formSnapshot: ScriptFormSnapshot | null;
  appliedSnapshot: ScriptFormSnapshot | null;
  isInterrupting: boolean;

  // Internal (not serialized)
  _bridge: ScriptFormBridge | null;

  // Actions — panel visibility
  togglePanel: () => void;
  openPanel: () => void;
  closePanel: () => void;

  // Actions — bridge
  setBridge: (bridge: ScriptFormBridge | null) => void;

  // Actions — revert / redo
  revert: () => void;
  redo: () => void;

  // Actions — session lifecycle
  createSession: (context?: ScriptBuilderContext) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  approveExecution: (executionId: string, approved: boolean) => Promise<void>;
  interruptResponse: () => Promise<void>;
  closeSession: () => Promise<void>;
  clearError: () => void;
}

// ============================================
// Apply tool names — when we see these in tool_result, we apply to the form
// ============================================

const APPLY_TOOL_NAMES = new Set(['apply_script_code', 'apply_script_metadata']);

// Normalise tool name that may come with MCP server prefix
function isApplyTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  // The tool name may arrive as "mcp__script_builder__apply_script_code"
  const base = toolName.includes('__') ? toolName.split('__').pop()! : toolName;
  return APPLY_TOOL_NAMES.has(base);
}

function baseToolName(toolName: string): string {
  return toolName.includes('__') ? toolName.split('__').pop()! : toolName;
}

// ============================================
// Store
// ============================================

export const useScriptAiStore = create<ScriptAiState>()(
  (set, get) => ({
    sessionId: null,
    messages: [],
    isStreaming: false,
    isLoading: false,
    error: null,
    pendingApproval: null,
    panelOpen: false,
    hasApplied: false,
    hasReverted: false,
    formSnapshot: null,
    appliedSnapshot: null,
    isInterrupting: false,
    _bridge: null,

    // Panel visibility
    togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
    openPanel: () => set({ panelOpen: true }),
    closePanel: () => set({ panelOpen: false }),

    // Bridge
    setBridge: (bridge) => set({ _bridge: bridge }),

    // Revert — restore the last snapshot, save current state for redo
    revert: () => {
      const { _bridge, formSnapshot } = get();
      if (!_bridge || !formSnapshot) return;
      const currentState = _bridge.takeSnapshot();
      _bridge.restoreSnapshot(formSnapshot);
      set({ hasApplied: false, hasReverted: true, appliedSnapshot: currentState });
    },

    // Redo — re-apply the reverted changes
    redo: () => {
      const { _bridge, appliedSnapshot } = get();
      if (!_bridge || !appliedSnapshot) return;
      const currentState = _bridge.takeSnapshot();
      _bridge.restoreSnapshot(appliedSnapshot);
      set({ hasApplied: true, hasReverted: false, formSnapshot: currentState, appliedSnapshot: null });
    },

    clearError: () => set({ error: null }),

    // ============================================
    // Session lifecycle
    // ============================================

    createSession: async (context?: ScriptBuilderContext) => {
      set({ isLoading: true, error: null });
      try {
        const res = await fetchWithAuth('/ai/script-builder/sessions', {
          method: 'POST',
          body: JSON.stringify({ context }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: 'Failed to create session' }));
          throw new Error(data.error || 'Failed to create session');
        }
        const data = await res.json();
        set({
          sessionId: data.id,
          messages: [],
          isLoading: false,
          hasApplied: false,
          hasReverted: false,
          formSnapshot: null,
          appliedSnapshot: null,
          pendingApproval: null,
        });
      } catch (err) {
        set({
          error: err instanceof Error ? err.message : 'Failed to create session',
          isLoading: false,
        });
      }
    },

    sendMessage: async (content: string) => {
      const trimmedContent = content.trim();
      if (!trimmedContent) return;

      const { sessionId, isStreaming, isLoading, _bridge } = get();

      // Prevent duplicate submits while a turn is in-flight
      if (isStreaming || isLoading) return;

      // Create session if needed — use current editor state as context
      if (!sessionId) {
        const editorContext: ScriptBuilderContext | undefined = _bridge
          ? { editorSnapshot: _bridge.getFormValues() as ScriptBuilderContext['editorSnapshot'] }
          : undefined;
        await get().createSession(editorContext);
      }

      const currentSessionId = get().sessionId;
      if (!currentSessionId) return;

      // Add user message optimistically
      const userMsgId = crypto.randomUUID();
      const userMsg: ScriptAiMessage = {
        id: userMsgId,
        role: 'user',
        content: trimmedContent,
        createdAt: new Date(),
      };

      set((s) => ({
        messages: [...s.messages, userMsg],
        isStreaming: true,
        error: null,
        pendingApproval: null,
      }));

      try {
        // Build editor context from bridge for system prompt refresh
        const bridge = get()._bridge;
        const editorContext: ScriptBuilderContext | undefined = bridge
          ? { editorSnapshot: bridge.getFormValues() as ScriptBuilderContext['editorSnapshot'] }
          : undefined;

        const res = await fetchWithAuth(
          `/ai/script-builder/sessions/${currentSessionId}/messages`,
          {
            method: 'POST',
            body: JSON.stringify({
              content: trimmedContent,
              editorContext,
            }),
          }
        );

        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: 'Failed to send message' }));

          // Conflict — remove optimistic message
          if (res.status === 409) {
            set((s) => ({
              messages: s.messages.filter((m) => m.id !== userMsgId),
              error: data.error || 'Another response is still in progress.',
            }));
            return;
          }

          throw new Error(data.error || 'Failed to send message');
        }

        // Process SSE stream
        const reader = res.body?.getReader();
        if (!reader) throw new Error('No response body');

        const decoder = new TextDecoder();
        let buffer = '';
        let currentAssistantId: string | null = null;
        let snapshotTakenThisTurn = false;
        let consecutiveParseFailures = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.startsWith('data:')) {
              const jsonStr = line.slice(5).trim();
              if (!jsonStr) continue;

              let event: AiStreamEvent;
              try {
                event = JSON.parse(jsonStr) as AiStreamEvent;
                consecutiveParseFailures = 0;
              } catch (parseErr) {
                consecutiveParseFailures++;
                console.error('[ScriptAI] Failed to parse SSE JSON:', jsonStr.slice(0, 200), parseErr);
                if (consecutiveParseFailures >= 5) {
                  set({ error: 'Stream became corrupted. Please try again.', isStreaming: false });
                  reader.cancel().catch((e) => console.warn('[ScriptAI] Cancel failed:', e));
                  return;
                }
                continue;
              }

              try {
                const result = processScriptStreamEvent(
                  event,
                  set,
                  get,
                  currentAssistantId,
                  snapshotTakenThisTurn,
                );
                currentAssistantId = result.currentAssistantId;
                snapshotTakenThisTurn = result.snapshotTaken;
              } catch (processErr) {
                console.error('[ScriptAI] Error processing SSE event:', event.type, processErr);
              }
            }
          }
        }
      } catch (err) {
        set({
          error: err instanceof Error ? err.message : 'Failed to send message. Please try again.',
          isStreaming: false,
        });
      } finally {
        // Ensure isStreaming is always reset
        const state = get();
        if (state.isStreaming) {
          set({ isStreaming: false });
        }
      }
    },

    approveExecution: async (executionId: string, approved: boolean) => {
      const { sessionId } = get();
      if (!sessionId) return;

      try {
        const res = await fetchWithAuth(
          `/ai/script-builder/sessions/${sessionId}/approve/${executionId}`,
          {
            method: 'POST',
            body: JSON.stringify({ approved }),
          }
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: 'Unknown error' }));
          set({ error: data.error || 'Failed to process approval. It may have timed out.' });
          return;
        }
        set({ pendingApproval: null });
      } catch (err) {
        console.error('[ScriptAI] Approval failed:', err);
        set({ error: 'Failed to process approval' });
      }
    },

    interruptResponse: async () => {
      const { sessionId } = get();
      if (!sessionId) return;

      set({ isInterrupting: true });
      try {
        const res = await fetchWithAuth(
          `/ai/script-builder/sessions/${sessionId}/interrupt`,
          { method: 'POST' }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.interrupted === false) {
          set({ error: data.reason || 'Could not interrupt the response' });
        }
      } catch (err) {
        console.error('[ScriptAI] Interrupt failed:', err);
        set({ error: 'Failed to interrupt the response' });
      } finally {
        set({ isInterrupting: false });
      }
    },

    closeSession: async () => {
      const { sessionId } = get();
      if (!sessionId) return;

      try {
        const res = await fetchWithAuth(
          `/ai/script-builder/sessions/${sessionId}`,
          { method: 'DELETE' }
        );
        if (!res.ok) {
          set({ error: 'Failed to close session' });
          return;
        }
        set({
          sessionId: null,
          messages: [],
          hasApplied: false,
          hasReverted: false,
          formSnapshot: null,
          appliedSnapshot: null,
          pendingApproval: null,
        });
      } catch (err) {
        console.error('[ScriptAI] Failed to close session:', err);
        set({ error: 'Failed to close session' });
      }
    },
  })
);

// ============================================
// SSE Event Processor
// ============================================

interface ProcessResult {
  currentAssistantId: string | null;
  snapshotTaken: boolean;
}

function processScriptStreamEvent(
  event: AiStreamEvent,
  set: (fn: (s: ScriptAiState) => Partial<ScriptAiState>) => void,
  get: () => ScriptAiState,
  currentAssistantId: string | null,
  snapshotTakenThisTurn: boolean,
): ProcessResult {
  switch (event.type) {
    case 'message_start': {
      const msg: ScriptAiMessage = {
        id: event.messageId,
        role: 'assistant',
        content: '',
        isStreaming: true,
        createdAt: new Date(),
      };
      set((s) => ({ messages: [...s.messages, msg] }));
      return { currentAssistantId: event.messageId, snapshotTaken: snapshotTakenThisTurn };
    }

    case 'content_delta': {
      if (currentAssistantId) {
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === currentAssistantId
              ? { ...m, content: m.content + event.delta }
              : m
          ),
        }));
      }
      return { currentAssistantId, snapshotTaken: snapshotTakenThisTurn };
    }

    case 'tool_use_start': {
      const toolMsg: ScriptAiMessage = {
        id: `tool-${event.toolUseId}`,
        role: 'tool_use',
        content: '',
        toolName: event.toolName,
        toolInput: event.input && Object.keys(event.input).length > 0 ? event.input : undefined,
        toolUseId: event.toolUseId,
        createdAt: new Date(),
      };
      set((s) => ({ messages: [...s.messages, toolMsg] }));
      return { currentAssistantId, snapshotTaken: snapshotTakenThisTurn };
    }

    case 'tool_result': {
      const resultMsg: ScriptAiMessage = {
        id: `result-${event.toolUseId}`,
        role: 'tool_result',
        content: typeof event.output === 'string'
          ? event.output
          : JSON.stringify(event.output, null, 2),
        toolOutput: event.output as Record<string, unknown>,
        toolUseId: event.toolUseId,
        isError: event.isError,
        createdAt: new Date(),
      };
      set((s) => ({ messages: [...s.messages, resultMsg] }));

      // Find the corresponding tool_use message to get the tool name
      const state = get();
      const toolUseMsg = state.messages.find(
        (m) => m.role === 'tool_use' && m.toolUseId === event.toolUseId
      );
      const toolName = toolUseMsg?.toolName;

      // If this is an apply tool result, apply changes to the form via bridge
      if (toolName && isApplyTool(toolName) && !event.isError) {
        const bridge = state._bridge;
        if (bridge) {
          // Take snapshot before first apply in this turn
          let didSnapshot = snapshotTakenThisTurn;
          if (!didSnapshot) {
            const snapshot = bridge.takeSnapshot();
            set(() => ({ formSnapshot: snapshot }));
            didSnapshot = true;
          }

          // Parse the output and apply to form
          try {
            const output = typeof event.output === 'string'
              ? JSON.parse(event.output)
              : event.output;

            const base = baseToolName(toolName);

            if (base === 'apply_script_code') {
              const values: Partial<ScriptFormSnapshot> = {};
              if (output.code != null) values.content = output.code;
              if (output.language != null) values.language = output.language;
              bridge.setFormValues(values);
            } else if (base === 'apply_script_metadata') {
              const values: Partial<ScriptFormSnapshot> = {};
              if (output.name != null) values.name = output.name;
              if (output.description != null) values.description = output.description;
              if (output.category != null) values.category = output.category;
              if (output.osTypes != null) values.osTypes = output.osTypes;
              if (output.parameters != null) values.parameters = output.parameters;
              if (output.runAs != null) values.runAs = output.runAs;
              if (output.timeoutSeconds != null) values.timeoutSeconds = output.timeoutSeconds;
              bridge.setFormValues(values);
            }

            set(() => ({ hasApplied: true, hasReverted: false, appliedSnapshot: null }));
          } catch (applyErr) {
            console.error('[ScriptAI] Failed to apply tool result to form:', applyErr);
          }

          return { currentAssistantId, snapshotTaken: didSnapshot };
        }
      }

      return { currentAssistantId, snapshotTaken: snapshotTakenThisTurn };
    }

    case 'approval_required': {
      set(() => ({
        pendingApproval: {
          executionId: event.executionId,
          toolName: event.toolName,
          input: event.input,
          description: event.description,
        },
      }));
      return { currentAssistantId, snapshotTaken: snapshotTakenThisTurn };
    }

    case 'message_end': {
      if (currentAssistantId) {
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === currentAssistantId ? { ...m, isStreaming: false } : m
          ),
        }));
      }
      return { currentAssistantId: null, snapshotTaken: snapshotTakenThisTurn };
    }

    case 'error': {
      set(() => ({ error: event.message, isStreaming: false }));
      return { currentAssistantId, snapshotTaken: snapshotTakenThisTurn };
    }

    case 'done': {
      set(() => ({ isStreaming: false }));
      return { currentAssistantId: null, snapshotTaken: snapshotTakenThisTurn };
    }

    // Ignore events not relevant to script builder (plan_*, title_updated, etc.)
    default:
      return { currentAssistantId, snapshotTaken: snapshotTakenThisTurn };
  }
}
