import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { deploymentResults } from '../db/schema';
import { redactSecretsFromOutput } from './secretRedaction';

/**
 * Command-id shape used for WS-dispatched software installs:
 * `sw-install-<deploymentUuid>-<deviceUuid>-<attemptNumber>`. The attempt
 * suffix is optional for backward compatibility with command ids already
 * queued/in-flight before it was introduced — those parse to attempt 0.
 * Shared by the HTTP result route (routes/agents/commands.ts) and the WS
 * orphan-result branch (routes/agentWs.ts) so both transports parse
 * identically.
 */
export const SW_INSTALL_COMMAND_ID_REGEX = /^sw-install-([0-9a-f-]{36})-([0-9a-f-]{36})(?:-(\d+))?$/i;

export interface SoftwareInstallResultInput {
  deploymentId: string;
  /** MUST come from the authenticated agent context, never from agent-supplied data. */
  deviceId: string;
  /** Agent-reported command status ('completed' | 'failed' | 'timeout'). */
  status: string;
  exitCode?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: string | null;
  /** RFC3339 string (or Date) captured by the agent when work began; optional for pre-#631 agents. */
  startedAt?: string | Date | null;
  durationMs?: number | null;
  /**
   * Which retry attempt this result belongs to — parsed from the WS command
   * id's `-<attemptNumber>` suffix, or from the queued device_commands
   * payload's `retryCount` field for the offline fallback transport. Defaults
   * to 0 (first attempt, and legacy command ids with no suffix). Compared
   * against the row's CURRENT retryCount so a late result from a
   * superseded attempt (retry already bumped retryCount and re-dispatched
   * under a new command id) is dropped instead of being misattributed to the
   * current attempt — see the retryCount column on deployment_results.
   */
  attemptNumber?: number;
}

/**
 * Map an agent software_install command result onto the matching
 * deployment_results row.
 *
 * - `completed` with a non-zero exit code is a failure (the installer ran and
 *   reported an error).
 * - startedAt prefers the agent-reported timestamp, falls back to
 *   reconstructing from durationMs for older agents, then to completedAt.
 * - output/errorMessage are redacted (PEM private-key blocks etc.) before
 *   persisting — mirrors buildStoredCommandResult on the device_commands path.
 * - The `status = 'pending'` guard makes double delivery (HTTP POST + WS
 *   orphan path, or a queued-command replay) a no-op: only the first result
 *   lands, later ones match zero rows.
 * - The `retryCount = attemptNumber` guard closes the retry race: the retry
 *   endpoint bumps retryCount BEFORE re-dispatching under a new command id
 *   carrying the new attempt number, so a late-arriving result from a
 *   superseded attempt no longer matches the row's current retryCount and is
 *   dropped rather than misattributed to the new attempt.
 *
 * Runs on the caller's DB context (agent request context or the agent WS
 * org-scoped context) via the plain `db` handle — same as the pre-extraction
 * inline code in routes/agents/commands.ts.
 */
export async function applySoftwareInstallResult(input: SoftwareInstallResultInput): Promise<void> {
  const attemptNumber = input.attemptNumber ?? 0;
  const drStatus =
    input.status === 'completed'
      ? input.exitCode && input.exitCode !== 0
        ? 'failed'
        : 'completed'
      : 'failed';
  const completedAt = new Date();
  // Prefer agent-reported startedAt (post-#631); fall back to reconstructing
  // from durationMs for older agents that don't carry it.
  const startedAt = input.startedAt
    ? new Date(input.startedAt)
    : input.durationMs
      ? new Date(completedAt.getTime() - input.durationMs)
      : completedAt;

  const query = db
    .update(deploymentResults)
    .set({
      status: drStatus,
      startedAt,
      completedAt,
      exitCode: input.exitCode ?? null,
      // Defense-in-depth: redact PEM private-key blocks from persisted
      // software-install output/errors (mirrors buildStoredCommandResult).
      output: input.stdout != null ? redactSecretsFromOutput(input.stdout) : null,
      errorMessage:
        input.error != null
          ? redactSecretsFromOutput(input.error)
          : input.stderr != null
            ? redactSecretsFromOutput(input.stderr)
            : null,
    })
    .where(
      and(
        eq(deploymentResults.deploymentId, input.deploymentId),
        eq(deploymentResults.deviceId, input.deviceId),
        eq(deploymentResults.status, 'pending'),
        eq(deploymentResults.retryCount, attemptNumber),
      ),
    );

  // .returning() lets us tell a genuine no-op (already applied/terminal) apart
  // from a stale-attempt rejection for logging; test doubles that only stub
  // `.where()` fall back to a plain await, matching every other caller of
  // this update.
  const updated = typeof (query as { returning?: unknown }).returning === 'function'
    ? await query.returning({ id: deploymentResults.id })
    : await query;

  if (Array.isArray(updated) && updated.length === 0) {
    console.warn(
      `[SoftwareDeploymentResult] Dropping software-install result for deployment=${input.deploymentId} ` +
      `device=${input.deviceId} attempt=${attemptNumber}: no pending row at this attempt ` +
      `(already applied, superseded by a retry, or unknown).`
    );
  }
}
