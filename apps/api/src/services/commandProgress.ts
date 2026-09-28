import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceCommands } from '../db/schema';
import { UUID_REGEX } from '../utils/uuid';

/**
 * #3578 — in-flight stages an agent may report for a command it is executing,
 * via the `command_progress` WS frame. ORDER MATTERS: a stage only ever
 * advances along this list, so a frame that arrives late (or twice) can never
 * move a command backwards. Append new stages; never reorder.
 *
 * Mirrored by the agent's `tools.ProgressStage*` constants
 * (agent/internal/remote/tools/software_install.go) and read by the web's
 * deployment results view.
 */
export const COMMAND_PROGRESS_STAGES = ['downloading', 'installing'] as const;

export type CommandProgressStage = (typeof COMMAND_PROGRESS_STAGES)[number];

/**
 * WS capability the server advertises in its `connected` handshake. Agents
 * send `command_progress` frames ONLY when it is present, so a new agent never
 * sprays frames an older server would reject as INVALID_MESSAGE.
 */
export const COMMAND_PROGRESS_CAPABILITY = 'command_progress';

export function isCommandProgressStage(value: unknown): value is CommandProgressStage {
  return typeof value === 'string' && (COMMAND_PROGRESS_STAGES as readonly string[]).includes(value);
}

/** Stages strictly earlier than `stage` — the only ones it may replace. */
export function commandProgressStagesBefore(stage: CommandProgressStage): CommandProgressStage[] {
  return COMMAND_PROGRESS_STAGES.slice(0, COMMAND_PROGRESS_STAGES.indexOf(stage));
}

export type ApplyCommandProgressResult =
  | { applied: true }
  | { applied: false; reason: 'invalid-command-id' | 'unknown-stage' | 'not-applicable' };

/**
 * Record the agent-reported in-flight stage on its device_commands row.
 *
 * Fire-and-forget and advisory: nothing gates on `progress_stage`, terminal
 * state is still owned by `status`, and a dropped frame only costs the UI a
 * stage label. The write matches only when
 *   - the row belongs to the AUTHENTICATED device (never an agent-supplied id),
 *   - it is an agent command still in flight (`status = 'sent'`) — a frame
 *     racing the terminal result, or arriving after a reaper timeout, is a
 *     no-op, and
 *   - the new stage is strictly later than the recorded one, so an out-of-order
 *     or duplicate frame cannot regress the stage or refresh its timestamp.
 *
 * device_commands is system-scoped (agent WS path, no org_id / RLS), so the
 * write runs in a system context outside any caller context — the same shape
 * as the terminal-result CAS in routes/agentWs.ts.
 */
export async function applyCommandProgress(params: {
  deviceId: string;
  commandId: string;
  stage: string;
  now?: Date;
}): Promise<ApplyCommandProgressResult> {
  if (!UUID_REGEX.test(params.commandId)) {
    return { applied: false, reason: 'invalid-command-id' };
  }
  const stage = params.stage;
  if (!isCommandProgressStage(stage)) {
    return { applied: false, reason: 'unknown-stage' };
  }

  const earlier = commandProgressStagesBefore(stage);
  const stageMayAdvance = earlier.length > 0
    ? or(isNull(deviceCommands.progressStage), inArray(deviceCommands.progressStage, earlier))
    : isNull(deviceCommands.progressStage);
  const progressAt = params.now ?? new Date();

  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .update(deviceCommands)
        .set({ progressStage: stage, progressAt })
        .where(
          and(
            eq(deviceCommands.id, params.commandId),
            eq(deviceCommands.deviceId, params.deviceId),
            eq(deviceCommands.targetRole, 'agent'),
            eq(deviceCommands.status, 'sent'),
            stageMayAdvance,
          ),
        )
        .returning({ id: deviceCommands.id }),
    ),
  );

  return rows.length > 0 ? { applied: true } : { applied: false, reason: 'not-applicable' };
}
