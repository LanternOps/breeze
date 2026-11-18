/**
 * execute_containment command outcomes -> incident_actions + incidents (#9662).
 *
 * `execute_containment` (aiToolsIncident.ts) records an `in_progress`
 * incident_actions row carrying the command id, then queues the command. This
 * module is the ONLY thing that moves that row to a terminal state, from the
 * command's real outcome:
 *
 * - the agent's result, over either transport (`handleExecuteContainmentResult`,
 *   registered in `commandResultHandlers` and the HTTP route's
 *   REGISTRY_DISPATCHED_COMMAND_TYPES);
 * - a server-side timeout or undelivered expiry (staleCommandReaper's
 *   `propagateTimedOutDeviceCommand`, also the manual "mark timed out" route);
 * - cancellation (`propagateCancelledDeviceCommand`).
 *
 * Only a COMPLETED agent result contains the incident. A server timeout is
 * recorded as `failed` with `timedOutBy: 'server'`, which a late real agent
 * result may still repair — the same contract device_commands has (#3607): the
 * process may really have been killed after the server stopped waiting.
 *
 * Deliberately a LEAF module (db, schema, the incident transition table):
 * `commandCancelPropagation` calls it from inside the heartbeat claim
 * transaction and must not gain an edge back into the command-queue graph.
 * The event bus is imported lazily, after commit.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db, runAfterDbContextCommit } from '../db';
import { incidentActions, incidents } from '../db/schema';
import type { IncidentTimelineEntry } from '../db/schema/incidentResponse';
import { ALLOWED_STATUS_TRANSITIONS } from '../routes/incidents.validation';
import { PG_UUID_REGEX } from '../utils/uuid';
import type { CommandResultHandler } from './commandResultHandlers';
import { captureException } from './sentry';

/** The ambient `db`, or a caller's open transaction handle. */
type DbExecutor = Pick<typeof db, 'update' | 'select'>;

export type ContainmentOutcome =
  /** The agent answered. Only `completed` counts as containment. */
  | { kind: 'agent'; status: 'completed' | 'failed'; error?: string | null; output?: unknown }
  /** The server stopped waiting (execution timeout or undelivered expiry). */
  | { kind: 'timeout'; error: string }
  /** The command was cancelled before or while it was delivered. */
  | { kind: 'cancelled'; error: string };

type ActionStatus = 'completed' | 'failed' | 'cancelled';

// Agent-supplied text lands on the incident; keep it bounded. The transports
// have already redacted error text before any handler runs (#2434).
const MAX_ERROR_CHARS = 2_000;
const MAX_OUTPUT_CHARS = 8_000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function actionStatusFor(outcome: ContainmentOutcome): ActionStatus {
  if (outcome.kind === 'agent') return outcome.status === 'completed' ? 'completed' : 'failed';
  return outcome.kind === 'timeout' ? 'failed' : 'cancelled';
}

const TIMELINE_TYPE: Record<ActionStatus, string> = {
  completed: 'containment_executed',
  failed: 'containment_failed',
  cancelled: 'containment_cancelled',
};

/** Incident statuses from which a successful containment moves it to `contained`. */
const CONTAINABLE_FROM = (Object.keys(ALLOWED_STATUS_TRANSITIONS) as Array<keyof typeof ALLOWED_STATUS_TRANSITIONS>)
  .filter((from) => from !== 'contained' && ALLOWED_STATUS_TRANSITIONS[from].includes('contained'));

/**
 * Move the incident action owned by `commandId` to its terminal state and
 * record it on the incident. Returns `no_action` when there is no open action
 * for this command (not a containment command, a replay, or already terminal).
 *
 * Persistence failures PROPAGATE: on the agent-result path that rolls the
 * result back and parks it reopenable (#3530); on the cancel path it rolls the
 * caller's cancel back with it.
 */
export async function finalizeContainmentAction(params: {
  commandId: string;
  /** The server-written command payload; `incidentId` is read from here only. */
  payload: Record<string, unknown> | null;
  outcome: ContainmentOutcome;
  completedAt: Date;
  executor?: DbExecutor;
}): Promise<'applied' | 'no_action'> {
  const { commandId, payload, outcome, completedAt } = params;
  const executor: DbExecutor = params.executor ?? db;

  const incidentId = typeof payload?.incidentId === 'string' ? payload.incidentId : null;
  if (!incidentId || !PG_UUID_REGEX.test(incidentId) || !PG_UUID_REGEX.test(commandId)) {
    return 'no_action';
  }

  const status = actionStatusFor(outcome);
  const error = outcome.kind === 'agent' ? outcome.error ?? null : outcome.error;
  const result: Record<string, unknown> = {
    commandId,
    commandStatus: outcome.kind === 'agent' ? outcome.status : outcome.kind,
    completedAt: completedAt.toISOString(),
    ...(error ? { error: clip(error, MAX_ERROR_CHARS) } : {}),
    ...(outcome.kind === 'timeout' ? { timedOutBy: 'server' } : {}),
    ...(outcome.kind === 'agent' && outcome.output !== undefined ? { output: outcome.output } : {}),
  };

  const open = inArray(incidentActions.status, ['pending', 'in_progress']);
  // Only a real agent answer may overwrite a server-side timeout; a timeout or
  // cancel never overwrites anything already terminal.
  const reopenable = outcome.kind === 'agent'
    ? or(open, and(eq(incidentActions.status, 'failed'), sql`${incidentActions.result}->>'timedOutBy' = 'server'`))
    : open;

  const [action] = await executor
    .update(incidentActions)
    .set({ status, result })
    .where(and(
      eq(incidentActions.incidentId, incidentId),
      sql`${incidentActions.result}->>'commandId' = ${commandId}`,
      reopenable,
    ))
    .returning({
      id: incidentActions.id,
      orgId: incidentActions.orgId,
      actionType: incidentActions.actionType,
      description: incidentActions.description,
      executedBy: incidentActions.executedBy,
    });

  if (!action) {
    // Benign for a duplicate result or a timeout racing a real answer, but it
    // is also what an incident invisible to this context looks like (RLS), so
    // leave a trace rather than drop the outcome silently.
    console.warn('[incidentContainment] no open containment action matched the command outcome', {
      commandId, incidentId, outcome: outcome.kind, status,
    });
    return 'no_action';
  }

  // Row lock: the status read below decides the transition, and must not be
  // overtaken by a concurrent locking writer between this read and the update.
  const [incident] = await executor
    .select({ id: incidents.id, orgId: incidents.orgId, status: incidents.status })
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1)
    .for('update');

  if (!incident) {
    console.warn('[incidentContainment] containment action finalized but its incident is not visible; timeline not updated', {
      commandId, incidentId, actionId: action.id,
    });
    return 'applied';
  }

  const contains = status === 'completed' && CONTAINABLE_FROM.includes(incident.status);
  const entry: IncidentTimelineEntry = {
    at: completedAt.toISOString(),
    type: TIMELINE_TYPE[status],
    actor: action.executedBy,
    summary: `${action.description} (${status})`,
    metadata: {
      actionId: action.id,
      actionType: action.actionType,
      actionStatus: status,
      commandId,
      ...(error ? { error: clip(error, MAX_ERROR_CHARS) } : {}),
    },
  };
  await executor
    .update(incidents)
    .set({
      // Appended in SQL, not read-modify-written: a writer that rewrites the
      // whole array without locking (routes/incidents.ts) must not be able to
      // make this entry disappear by racing a stale copy over it.
      timeline: sql`coalesce(${incidents.timeline}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`,
      updatedAt: completedAt,
      ...(contains ? { status: 'contained' as const, containedAt: completedAt } : {}),
    })
    .where(eq(incidents.id, incident.id));

  if (contains) {
    // A subscriber must never hear about a containment that rolled back.
    runAfterDbContextCommit('incidentContainment.contained', async () => {
      try {
        const { publishEvent } = await import('./eventBus');
        await publishEvent(
          'incident.contained',
          incident.orgId,
          {
            incidentId: incident.id,
            actionId: action.id,
            actionType: action.actionType,
            executedBy: action.executedBy,
            status,
          },
          'incident-containment-result',
        );
      } catch (err) {
        console.error('[incidentContainment] Failed to publish incident.contained event:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  return 'applied';
}

const MAX_OUTPUT_FIELDS = 16;
const MAX_OUTPUT_STRING_CHARS = 256;

/**
 * The agent's structured result (NewSuccessResult marshals it to stdout JSON,
 * e.g. `{ actionType, pid, name, killed }` for process_kill).
 *
 * stdout is NOT redacted by the transports (only error/stderr are, #2434), so
 * only bounded top-level scalars are kept — enough to say what was contained,
 * never an arbitrary device-supplied blob. An unreadable stdout keeps none.
 */
function parseOutput(stdout: string | undefined): Record<string, string | number | boolean> | undefined {
  if (!stdout || stdout.length > MAX_OUTPUT_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>).slice(0, MAX_OUTPUT_FIELDS)) {
    if (typeof value === 'string') out[key] = clip(value, MAX_OUTPUT_STRING_CHARS);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/** Registry handler: both agent transports authorize the command before calling it. */
export async function handleExecuteContainmentResult(
  args: Parameters<CommandResultHandler>[0],
): Promise<void> {
  const { command, commandId, result, stdout } = args;
  if ((command.payload as Record<string, unknown> | null)?.actionType === 'network_isolation') {
    const { findEpisodeByCommand } = await import('./networkIsolation/episodeStore');
    if (await findEpisodeByCommand(db, commandId)) {
      const { handleNetworkIsolationResult } = await import('./networkIsolation/finalizer');
      return handleNetworkIsolationResult(args);
    }
  }
  const completed = result.status === 'completed';
  await finalizeContainmentAction({
    // The transport-authorized id, never one read off the agent's body.
    commandId,
    payload: (command.payload ?? null) as Record<string, unknown> | null,
    outcome: {
      kind: 'agent',
      status: completed ? 'completed' : 'failed',
      error: completed ? null : (result.error ?? result.stderr ?? `agent reported ${result.status}`),
      ...(completed ? { output: parseOutput(stdout) } : {}),
    },
    completedAt: new Date(),
  });
}
