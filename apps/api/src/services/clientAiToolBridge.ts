/**
 * AI for Office — client-side tool execution bridge (spec §5).
 *
 * Office.js only runs inside Excel, so workbook tools execute IN THE ADD-IN:
 *   1. The MCP tool handler (services/clientAiTools.ts) calls
 *      requestClientToolExecution → publishes a `tool_request` SSE event on
 *      the session's SessionEventBus and parks an in-memory resolver here.
 *   2. The add-in executes via Office.js (write tools behind the user's
 *      Apply/Reject preview card) and posts
 *      POST /client-ai/sessions/:id/tool-results { toolUseId, status, output }.
 *   3. The route calls resolveClientToolResult → the handler resumes and the
 *      SDK loop continues.
 *
 * Timeouts resolve (never reject) with a timeout-shaped result so the model is
 * told and can react (e.g. the user closed Excel). 60s reads / 300s mutating —
 * the mutating window covers the in-pane approval wait and stays inside the
 * manager's 6-min SDK_TURN_TIMEOUT_MS (streamingSessionManager.ts:37).
 *
 * The pending map is in-process memory by design: the SDK session is a child
 * subprocess of this API instance and production runs a single api container
 * per region — the same affinity the technician /ai approval endpoint already
 * relies on. This is the waitForPlanApproval in-memory-resolver shape
 * (services/aiAgent.ts:323), not the DB-polling waitForApproval shape.
 */

import type { ActiveSession } from './streamingSessionManager';

export const CLIENT_TOOL_TIMEOUT_MS = 60_000;
export const CLIENT_MUTATING_TOOL_TIMEOUT_MS = 300_000;

export interface ClientToolResult {
  status: 'success' | 'error' | 'rejected' | 'timeout';
  output: unknown;
}

interface PendingClientToolRequest {
  sessionId: string;
  toolName: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: ClientToolResult) => void;
}

const pending = new Map<string, PendingClientToolRequest>();

export function requestClientToolExecution(
  session: ActiveSession,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  mutating: boolean,
): Promise<ClientToolResult> {
  return new Promise<ClientToolResult>((resolve) => {
    const timeoutMs = mutating ? CLIENT_MUTATING_TOOL_TIMEOUT_MS : CLIENT_TOOL_TIMEOUT_MS;
    const timer = setTimeout(() => {
      pending.delete(toolUseId);
      resolve({
        status: 'timeout',
        output: {
          error: `Tool '${toolName}' timed out after ${Math.round(timeoutMs / 1000)}s — the user may have closed the document or not responded to the approval prompt.`,
        },
      });
    }, timeoutMs);

    pending.set(toolUseId, { sessionId: session.breezeSessionId, toolName, timer, resolve });

    session.eventBus.publish({ type: 'tool_request', toolUseId, toolName, input, mutating });
  });
}

/**
 * Resolve a pending request from POST /tool-results. Returns false when the
 * id is unknown, already resolved/timed out, or belongs to ANOTHER session
 * (cross-session guard — toolUseIds are not secrets).
 */
export function resolveClientToolResult(
  sessionId: string,
  toolUseId: string,
  result: { status: 'success' | 'error' | 'rejected'; output: unknown },
): boolean {
  const entry = pending.get(toolUseId);
  if (!entry || entry.sessionId !== sessionId) return false;
  clearTimeout(entry.timer);
  pending.delete(toolUseId);
  entry.resolve({ status: result.status, output: result.output ?? null });
  return true;
}

/** Fail every pending request of a session (close/teardown). Returns the count failed. */
export function failPendingForSession(sessionId: string, reason = 'session_closed'): number {
  let failed = 0;
  for (const [toolUseId, entry] of [...pending.entries()]) {
    if (entry.sessionId !== sessionId) continue;
    clearTimeout(entry.timer);
    pending.delete(toolUseId);
    entry.resolve({ status: 'error', output: { error: reason } });
    failed++;
  }
  return failed;
}

/** Test-only visibility into the pending map. */
export function _pendingCountForTests(): number {
  return pending.size;
}
