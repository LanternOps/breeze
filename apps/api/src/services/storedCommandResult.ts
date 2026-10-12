import type { z } from 'zod';
import type { commandResultSchema } from '../routes/agents/schemas';
import { redactSecretsFromOutput } from './secretRedaction';
import { isRawStdoutArtifactCommand } from './commandAudit';
import { collapseAgentReportedTimeoutStatus } from './commandResultAcceptance';

/**
 * The object persisted into `device_commands.result` for an agent command
 * result. Shared by both ingest legs — the WebSocket handler
 * (routes/agentWs.ts) and its REST twin (routes/agents/commands.ts) — which
 * used to carry byte-identical private copies of this function.
 *
 * It is built field-by-field on purpose (redaction, timeout collapse), so a
 * new wire field is dropped here unless it is added explicitly — and whatever
 * is dropped never reaches executeCommand's caller. `errorCode` (#4026) is the
 * case in point: without it, classifyCommandFailure keeps matching prose even
 * for agents that send the typed code.
 */
export function buildStoredCommandResult(
  commandType: string,
  result: z.infer<typeof commandResultSchema>,
  stdout: string | undefined,
) {
  // Defense-in-depth: strip full PEM private-key blocks from agent output
  // BEFORE it is persisted and later shown to scripts:read users. Pre-update
  // agents don't redact server-side-visible output, so we redact here.
  // Preserve null/undefined (don't coerce to '') to keep the stored shape
  // stable; exitCode/status/durationMs are untouched.
  //
  // Exception: artifact-bearing stdout (capture_pprof base64 profiles) must be
  // stored byte-for-byte -- the redaction patterns statistically fire inside
  // megabytes of random base64 and would silently corrupt the artifact (#2401).
  const skipStdoutRedaction = isRawStdoutArtifactCommand(commandType);
  return {
    // See collapseAgentReportedTimeoutStatus: an agent-reported 'timeout'
    // must never be stored verbatim — that literal string doubles as the
    // server's own reopen marker.
    status: collapseAgentReportedTimeoutStatus(result.status),
    exitCode: result.exitCode,
    stdout: stdout != null && !skipStdoutRedaction ? redactSecretsFromOutput(stdout) : stdout,
    stderr: result.stderr != null ? redactSecretsFromOutput(result.stderr) : result.stderr,
    durationMs: result.durationMs,
    error: result.error != null
      ? redactSecretsFromOutput(result.error)
      : result.status === 'timeout' ? 'Agent reported a timeout' : result.error,
    // A machine code from a closed vocabulary, not free text: nothing to
    // redact. Absent for agents that predate it.
    errorCode: result.errorCode,
  };
}
