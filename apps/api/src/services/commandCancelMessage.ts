/**
 * The requester-facing error for a command that claim-time eligibility
 * cancelled before it reached the agent (`device_commands.result.reason`).
 * One wording for every caller that surfaces it (interactive commands, the
 * WebSocket push callers), so the same refusal reads the same everywhere.
 *
 * Kept dependency-free on purpose: callers' unit tests mock `commandDispatch`
 * wholesale, and this must stay real under those mocks.
 */
export function cancelledCommandError(reason: string | null | undefined): string {
  return `Command cancelled before delivery (${reason || 'unknown'})`;
}
