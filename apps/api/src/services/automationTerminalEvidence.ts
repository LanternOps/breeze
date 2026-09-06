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
