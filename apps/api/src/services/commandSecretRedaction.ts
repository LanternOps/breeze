import { buildExactValueRedactor } from './exactSecretRedaction';
import { openSecretEnv, SCRIPT_SECRET_ENVELOPE_FIELD } from './scriptSecretEnvelope';
import { captureException } from './sentry';

/**
 * Replaces ALL output when the server cannot verify what the agent sent against
 * the secrets the command carried. Status and exit code survive — the operator
 * still learns whether the script succeeded — but unverifiable text is never
 * persisted, because it may contain a credential we no longer have the means
 * to find.
 */
export const OUTPUT_VERIFICATION_FAILED_MARKER = '[OUTPUT_REDACTED:VERIFICATION_FAILED]';

/**
 * Redact a command result against the secret values THAT COMMAND carried.
 *
 * Called at both agent-result ingest chokepoints (`agentWs.processCommandResult`
 * and the REST twin in `routes/agents/commands.ts`), after normalization and
 * BEFORE anything is persisted — `device_commands.result` and, downstream via
 * the per-type handlers, `script_executions.stdout/stderr/error_message`. The
 * envelope is opened for this single purpose; the plaintext values never leave
 * this function.
 *
 * The exact-value layer runs FIRST; the pre-existing name-based heuristic
 * (`redactSecretsFromOutput`) still runs at its established sites afterwards
 * and catches secrets this command never carried. Both are idempotent, so the
 * double pass costs nothing.
 *
 * Inert until #3409 PR4c: no command carries an envelope yet, so every call is
 * the identity passthrough below.
 */
export function redactResultAgainstCommandSecrets<
  R extends { stdout?: string | null; stderr?: string | null; error?: string | null },
  S extends string | null | undefined,
>(
  command: { id: string; type: string; deviceId: string; payload: unknown },
  result: R,
  stdout: S,
): { result: R; stdout: S } {
  const payload = command.payload;
  const envelope =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)[SCRIPT_SECRET_ENVELOPE_FIELD]
      : undefined;
  if (typeof envelope !== 'string' || !envelope) {
    return { result, stdout };
  }

  let values: string[];
  try {
    values = Object.values(
      openSecretEnv(envelope, { commandId: command.id, deviceId: command.deviceId }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Never log the envelope or any key material — only the identifiers.
    console.error(
      '[commandSecretRedaction] could not open the secret envelope for a completed command; discarding its output',
      { commandId: command.id, deviceId: command.deviceId, error: message },
    );
    captureException(
      new Error(
        `[commandSecretRedaction] envelope open failed after execution (commandId=${command.id}): ${message}`,
      ),
    );
    // Only fields that actually carried text are replaced: a field the agent
    // left empty has nothing to leak, and inventing output there would make an
    // empty result look like a suppressed one. The `as S` cast is sound —
    // `text != null` means S includes string.
    const discard = <T extends string | null | undefined>(text: T): T =>
      (text != null ? OUTPUT_VERIFICATION_FAILED_MARKER : text) as T;
    return {
      result: {
        ...result,
        stdout: discard(result.stdout),
        stderr: discard(result.stderr),
        error: discard(result.error),
      },
      stdout: discard(stdout),
    };
  }

  const redact = buildExactValueRedactor(values);
  const apply = <T extends string | null | undefined>(text: T): T =>
    (text != null ? redact(text) : text) as T;

  return {
    result: {
      ...result,
      stdout: apply(result.stdout),
      stderr: apply(result.stderr),
      error: apply(result.error),
    },
    stdout: apply(stdout),
  };
}
