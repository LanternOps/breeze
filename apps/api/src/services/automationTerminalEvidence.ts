import { applyAutomationActionTerminal } from './automationActionResults';

export type AgentTerminalEvidence = {
  status: string;
  exitCode?: number | null;
};

/** One command-result mapping shared by the HTTP and WebSocket transports. */
export function mapCommandTerminalEvidence(
  result: AgentTerminalEvidence,
): 'succeeded' | 'failed' {
  return result.status === 'completed' && (result.exitCode == null || result.exitCode === 0)
    ? 'succeeded'
    : 'failed';
}

export async function applyCommandAutomationTerminal(input: {
  commandId: string;
  result: AgentTerminalEvidence;
  output?: string | null;
  error?: string | null;
  completedAt?: Date;
}): Promise<boolean> {
  return applyAutomationActionTerminal({
    source: 'command',
    commandId: input.commandId,
    terminalStatus: mapCommandTerminalEvidence(input.result),
    output: input.output ?? null,
    error: input.error ?? null,
    completedAt: input.completedAt ?? new Date(),
  });
}

/**
 * #5290 — map an `ai.agent.run.*` event type onto the terminal status of the
 * automation action that enqueued that run. Returns null for any other event.
 */
export function mapAgentRunTerminalEvidence(
  eventType: string,
): 'succeeded' | 'failed' | 'skipped' | null {
  if (eventType === 'ai.agent.run.completed') return 'succeeded';
  if (eventType === 'ai.agent.run.failed') return 'failed';
  if (eventType === 'ai.agent.run.skipped') return 'skipped';
  return null;
}

export async function applyAgentRunAutomationTerminal(input: {
  agentRunId: string;
  terminalStatus: 'succeeded' | 'failed' | 'skipped';
  error?: string | null;
  completedAt?: Date;
}): Promise<boolean> {
  return applyAutomationActionTerminal({
    source: 'agent_run',
    agentRunId: input.agentRunId,
    terminalStatus: input.terminalStatus,
    output: null,
    error: input.error ?? null,
    completedAt: input.completedAt ?? new Date(),
  });
}

/**
 * Durable-subscriber entry point. A no-op for an agent run that no automation
 * action is waiting on (the common case: manually triggered and scheduled runs
 * far outnumber ai_triage ones), and for any event type that is not terminal.
 */
export async function handleAgentRunTerminalForAutomation(
  event: { type: string; payload?: Record<string, unknown> | null },
): Promise<void> {
  const terminalStatus = mapAgentRunTerminalEvidence(event.type);
  if (!terminalStatus) return;

  const payload = event.payload ?? {};
  const agentRunId = typeof payload.runId === 'string'
    ? payload.runId
    : typeof payload.agentRunId === 'string'
      ? payload.agentRunId
      : null;
  if (!agentRunId) {
    // NOT the harmless case above: the subscriber only receives the three
    // terminal ai.agent.run.* types, so a missing run id here is a malformed
    // payload for an event we explicitly asked for. Left silent, the correlated
    // action would sit non-terminal until the reaper stamped a provisional
    // timeout over the child run's real outcome.
    console.error(
      `[AutomationTerminalEvidence] ${event.type} carried no run id; the correlated automation action cannot be terminalised`,
    );
    return;
  }

  const error = typeof payload.error === 'string' ? payload.error : null;
  await applyAgentRunAutomationTerminal({ agentRunId, terminalStatus, error });
}
